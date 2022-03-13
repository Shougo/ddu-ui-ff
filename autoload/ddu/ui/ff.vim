let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-ff') : 0

function! ddu#ui#ff#do_action(name, ...) abort
  if !exists('b:ddu_ui_name')
    return
  endif

  call ddu#ui_action(b:ddu_ui_name, a:name, get(a:000, 0, {}))
endfunction

function! ddu#ui#ff#execute(command) abort
  if !exists('g:ddu#ui#ff#_filter_parent_winid')
    return
  endif

  call win_execute(g:ddu#ui#ff#_filter_parent_winid, a:command)
  call win_execute(g:ddu#ui#ff#_filter_parent_winid, 'redraw')
endfunction

function! ddu#ui#ff#_update_buffer(
      \ params, bufnr, selected_items, highlight_items, lines, refreshed, pos) abort
  let max_lines = len(a:lines)
  call setbufvar(a:bufnr, '&modifiable', 1)

  call setbufline(a:bufnr, 1, a:params.reversed ? reverse(a:lines) : a:lines)
  silent call deletebufline(a:bufnr, max_lines + 1, '$')

  call setbufvar(a:bufnr, '&modifiable', 0)
  call setbufvar(a:bufnr, '&modified', 0)

  if a:refreshed
    " Init the cursor
    call win_execute(bufwinid(a:bufnr),
          \ printf('call cursor(%d, 0) | redraw',
          \ a:params.reversed ? max_lines - a:pos : a:pos + 1))
  endif

  call win_execute(bufwinid(a:bufnr), 'normal! zb')

  " Clear all highlights
  if has('nvim')
    call nvim_buf_clear_namespace(0, s:namespace, 0, -1)
  else
    call prop_clear(1, max_lines + 1, { 'bufnr': a:bufnr })
  endif

  " Highlights items
  for item in a:highlight_items
    for hl in item.highlights
      call ddu#ui#ff#_highlight(
            \ hl.hl_group, hl.name, 1,
            \ s:namespace, a:bufnr,
            \ a:params.reversed ? max_lines - item.row + 1 : item.row,
            \ hl.col + strwidth(item.prefix), hl.width)
    endfor
  endfor

  " Selected items highlights
  for item_nr in a:selected_items
    call ddu#ui#ff#_highlight(
          \ 'Statement', 'ddu-ui-selected', 10000,
          \ s:namespace, a:bufnr, item_nr + 1, 1, 1000)
  endfor

  if !has('nvim')
    " Note: :redraw is needed for Vim
    redraw
  endif
endfunction

function! ddu#ui#ff#_highlight(
      \ highlight, prop_type, priority, id, bufnr, row, col, length) abort
  if !has('nvim')
    " Add prop_type
    if empty(prop_type_get(a:prop_type))
      call prop_type_add(a:prop_type, {
            \ 'highlight': a:highlight,
            \ 'priority': a:priority,
            \ })
    endif
  endif

  if has('nvim')
    call nvim_buf_add_highlight(
          \ a:bufnr,
          \ a:id,
          \ a:highlight,
          \ a:row - 1,
          \ a:col - 1,
          \ a:col - 1 + a:length
          \ )
  else
    call prop_add(a:row, a:col, {
          \ 'length': a:length,
          \ 'type': a:prop_type,
          \ 'bufnr': a:bufnr,
          \ 'id': a:id,
          \ })
  endif
endfunction

function! ddu#ui#ff#_preview_file(params, filename) abort
  let preview_width = a:params.previewWidth
  let preview_height = a:params.previewHeight
  let pos = win_screenpos(win_getid())
  let win_width = winwidth(0)
  let win_height = winheight(0)

  if a:params.previewVertical
    if a:filename ==# ''
      silent rightbelow vnew
    else
      call ddu#util#execute_path(
            \ 'silent rightbelow vertical pedit!', a:filename)
      wincmd P
    endif

    if a:params.previewFloating && exists('*nvim_win_set_config')
      if a:params.split ==# 'floating'
        let win_row = a:params['winRow']
        let win_col = a:params['winCol']
      else
        let win_row = pos[0] - 1
        let win_col = pos[1] - 1
      endif
      let win_col += win_width
      if (win_col + preview_width) > &columns
        let win_col -= preview_width
      endif

      call nvim_win_set_config(win_getid(), {
           \ 'relative': 'editor',
           \ 'row': win_row,
           \ 'col': win_col,
           \ 'width': preview_width,
           \ 'height': preview_height,
           \ })
    else
      execute 'vert resize ' . preview_width
    endif
  else
    if a:filename ==# ''
      silent aboveleft new
    else
      call ddu#util#execute_path('silent aboveleft pedit!', a:filename)

      wincmd P
    endif

    if a:params.previewFloating && exists('*nvim_win_set_config')
      let win_row = pos[0] - 1
      let win_col = pos[1] + 1
      if win_row <= preview_height
        let win_row += win_height + 1
        let anchor = 'NW'
      else
        let anchor = 'SW'
      endif

      call nvim_win_set_config(0, {
            \ 'relative': 'editor',
            \ 'anchor': anchor,
            \ 'row': win_row,
            \ 'col': win_col,
            \ 'width': preview_width,
            \ 'height': preview_height,
            \ })
    else
      execute 'resize ' . preview_height
    endif
  endif

  " Note: Open folds and centering
  normal! zvzz
endfunction
