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

  let winid = g:ddu#ui#ff#_filter_parent_winid
  let prev_curpos = s:getcurpos(winid)

  call win_execute(winid, a:command . ' | redraw')

  if s:getcurpos(winid) != prev_curpos
    " Note: CursorMoved autocmd does not work when cursor()
    call win_execute(winid, 'silent! doautocmd CursorMoved | redraw')
  endif
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
    let winid = bufwinid(a:bufnr)
    let curpos = s:getcurpos(winid)
    let lnum = a:params.reversed ? max_lines - a:pos : a:pos + 1
    if curpos[1] != lnum
      call win_execute(winid,
            \ printf('call cursor(%d, 0) | normal! zb', lnum))
    elseif a:params.reversed
      call win_execute(winid, 'normal! zb')
    endif
  endif

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

function! ddu#ui#ff#_open_preview_window(params) abort
  let preview_width = a:params.previewWidth
  let preview_height = a:params.previewHeight
  let pos = win_screenpos(win_getid())
  let win_width = winwidth(0)
  let win_height = winheight(0)

  if a:params.previewVertical
    silent rightbelow vnew

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
    silent aboveleft new

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
endfunction

function! s:getcurpos(winid)
  if has('nvim-0.7') || !has('nvim')
    return getcurpos(a:winid)
  endif

  " Note: Old neovim does not support getcurpos({winid})
  let prev_winid = win_getid()
  call win_gotoid(a:winid)
  let cursor = getcurpos()
  call win_gotoid(prev_winid)
  return cursor
endfunction

let s:cursor_row = -1
let s:auto_action = {}
function! s:do_auto_action() abort
  let line = line('.')
  if line != s:cursor_row
    call ddu#ui#ff#do_action(s:auto_action.name, s:auto_action.params)
    let s:cursor_row = line
  endif
endfunction
function! ddu#ui#ff#_reset_auto_action() abort
  let s:cursor_row = -1
  let s:auto_action = {}
  augroup ddu-ui-auto_action
    autocmd!
  augroup END
endfunction
function! ddu#ui#ff#_set_auto_action(auto_action) abort
  let s:auto_action = a:auto_action
  autocmd ddu-ui-auto_action CursorMoved <buffer> call s:do_auto_action()
endfunction
