let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-ff') : 0

function! ddu#ui#ff#do_action(name, options = {}) abort
  return ddu#ui#do_action(a:name, a:options)
endfunction

function! ddu#ui#ff#multi_actions(actions) abort
  return ddu#ui#multi_actions(a:actions)
endfunction

function! ddu#ui#ff#execute(command) abort
  if !('g:ddu#ui#ff#_filter_parent_winid'->exists())
    return
  endif

  const winid = g:ddu#ui#ff#_filter_parent_winid
  const prev_curpos = s:getcurpos(winid)

  call win_execute(winid, a:command)

  if s:getcurpos(winid) != prev_curpos
    " NOTE: CursorMoved autocmd does not work when cursor()
    call win_execute(winid, 'doautocmd CursorMoved')
  endif
endfunction

function! ddu#ui#ff#_update_buffer(params, bufnr, lines, refreshed, pos) abort
  const max_lines = a:lines->len()
  const winid = a:bufnr->bufwinid()
  const current_lines = '$'->line(winid)

  call setbufvar(a:bufnr, '&modifiable', 1)

  call setbufline(a:bufnr, 1, a:params.reversed ? reverse(a:lines) : a:lines)
  if current_lines > max_lines
    silent call deletebufline(a:bufnr, max_lines + 1, '$')
  endif

  call setbufvar(a:bufnr, '&modifiable', 0)
  call setbufvar(a:bufnr, '&modified', 0)

  if !a:refreshed
    return
  endif

  " Init the cursor
  const curpos = s:getcurpos(winid)
  const lnum = a:params.reversed ? max_lines - a:pos : a:pos + 1
  if curpos[1] != lnum
    call win_execute(winid,
          \ printf('call cursor(%d, 0) | normal! zb', lnum))
  elseif a:params.reversed
    call win_execute(winid, 'normal! zb')
  endif
endfunction

function! ddu#ui#ff#_highlight_items(
      \ params, bufnr, max_lines, highlight_items, selected_items) abort
  " Buffer must be loaded
  if !(a:bufnr->bufloaded())
    return
  endif

  " Clear all highlights
  if has('nvim')
    call nvim_buf_clear_namespace(0, s:namespace, 0, -1)
  else
    call prop_clear(1, a:max_lines + 1, #{ bufnr: a:bufnr })
  endif

  " Highlights items
  for item in a:highlight_items
    for hl in item.highlights
      call ddu#ui#ff#_highlight(
            \ hl.hl_group, hl.name, 1,
            \ s:namespace, a:bufnr,
            \ a:params.reversed ? a:max_lines - item.row + 1 : item.row,
            \ hl.col + strwidth(item.prefix), hl.width)
    endfor
  endfor

  " Selected items highlights
  let selected_highlight = a:params.highlights->get('selected', 'Statement')
  for item_nr in a:selected_items
    call ddu#ui#ff#_highlight(
          \ selected_highlight, 'ddu-ui-selected', 10000,
          \ s:namespace, a:bufnr, item_nr + 1, 1, 1000)
  endfor

  if !has('nvim')
    " NOTE: :redraw is needed for Vim
    redraw
  endif
endfunction

function! ddu#ui#ff#_highlight(
      \ highlight, prop_type, priority, id, bufnr, row, col, length) abort
  if !has('nvim')
    " Add prop_type
    if a:prop_type->prop_type_get()->empty()
      call prop_type_add(a:prop_type, #{
            \   highlight: a:highlight,
            \   priority: a:priority,
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
    call prop_add(a:row, a:col, #{
          \   length: a:length,
          \   type: a:prop_type,
          \   bufnr: a:bufnr,
          \   id: a:id,
          \ })
  endif
endfunction

function! ddu#ui#ff#_open_preview_window(params, bufnr, prev_winid) abort
  let preview_width = a:params.previewWidth
  let preview_height = a:params.previewHeight
  const winnr = a:bufnr->bufwinid()
  const pos = winnr->win_screenpos()
  const win_width = winnr->winwidth()
  const win_height = winnr->winheight()

  if a:params.previewSplit ==# 'vertical'
    if a:params.previewFloating && '*nvim_win_set_config'->exists()
      const buf = nvim_create_buf(v:true, v:false)

      if a:params.split ==# 'floating'
        let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
        let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1
        let preview_height = win_height
      else
        let win_row = pos[0] - 1
        let win_col = pos[1] - 1
      endif
      let win_col += win_width
      if (win_col + preview_width) > &columns
        let win_col -= preview_width
      endif

      call nvim_open_win(buf, v:true, #{
            \   relative: 'editor',
            \   row: win_row,
            \   col: win_col,
            \   width: preview_width,
            \   height: preview_height,
            \   border: a:params.previewFloatingBorder,
            \   title: a:params.previewFloatingTitle,
            \   title_pos: a:params.previewFloatingTitlePos,
            \   zindex: a:params.previewFloatingZindex,
            \ })
    else
      silent rightbelow vnew
      execute 'vert resize ' .. preview_width
    endif
  elseif a:params.previewSplit ==# 'horizontal'
    if a:params.previewFloating && '*nvim_win_set_config'->exists()
      const buf = nvim_create_buf(v:true, v:false)

      if a:params.split ==# 'floating'
        let preview_width = win_width
      endif

      let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
      let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1
      if a:params.previewRow <= 0 && win_row <= preview_height
        let win_row += win_height + 1
        const anchor = 'NW'
      else
        const anchor = 'SW'
      endif

      call nvim_open_win(buf, v:true, #{
            \   relative: 'editor',
            \   anchor: anchor,
            \   row: win_row,
            \   col: win_col,
            \   width: preview_width,
            \   height: preview_height,
            \   border: a:params.previewFloatingBorder,
            \   title: a:params.previewFloatingTitle,
            \   title_pos: a:params.previewFloatingTitlePos,
            \   zindex: a:params.previewFloatingZindex,
            \ })
    else
      silent aboveleft new
      execute 'resize ' .. preview_height
    endif
  elseif a:params.previewSplit ==# 'no'
    call win_gotoid(a:prev_winid)
  endif
endfunction

function! s:getcurpos(winid) abort
  if has('nvim-0.7') || !has('nvim')
    return getcurpos(a:winid)
  endif

  " NOTE: Old neovim does not support getcurpos({winid})
  const prev_winid = win_getid()
  call win_gotoid(a:winid)
  const cursor = getcurpos()
  call win_gotoid(prev_winid)
  return cursor
endfunction

let s:cursor_text = ''
let s:auto_action = {}
let s:debounce_timer = -1
function! ddu#ui#ff#_do_auto_action() abort
  silent! call timer_stop(s:debounce_timer)
  let s:debounce_timer = timer_start(
        \ s:auto_action.delay, { -> s:do_auto_action() })
endfunction
function! s:do_auto_action() abort
  if empty(s:auto_action)
    return
  endif

  const winid = (&l:filetype ==# 'ddu-ff'
        \        || !('g:ddu#ui#ff#_filter_parent_winid'->exists()))
        \ ? win_getid() : g:ddu#ui#ff#_filter_parent_winid
  const bufnr = winid->winbufnr()

  const text = bufnr->getbufline(s:getcurpos(winid)[1])[0]
  if text != s:cursor_text
    if s:auto_action.sync
      call ddu#ui#sync_action(s:auto_action.name, s:auto_action.params)
    else
      call ddu#ui#do_action(s:auto_action.name, s:auto_action.params)
    endif
    let s:cursor_text = text
  endif
endfunction
function! ddu#ui#ff#_reset_auto_action() abort
  silent! call timer_stop(s:debounce_timer)
  let s:debounce_timer = -1
  let s:cursor_text = ''
  let s:auto_action = {}
  augroup ddu-ui-auto_action
    autocmd!
  augroup END
endfunction
function! ddu#ui#ff#_set_auto_action(auto_action) abort
  let s:auto_action = a:auto_action

  " NOTE: In action execution, auto action should be skipped
  augroup ddu-ui-auto_action
    autocmd CursorMoved <buffer> ++nested
          \ : if !(g:->get('ddu#ui#ff#_in_action', v:false))
          \ |   call ddu#ui#ff#_do_auto_action()
          \ | endif
  augroup END
endfunction

function! ddu#ui#ff#_cursor(line, col) abort
  if &l:filetype ==# 'ddu-ff'
        \ || !('g:ddu#ui#ff#_filter_parent_winid'->exists())
    call cursor(a:line, a:col)
    normal! zb
  else
    const winid = g:ddu#ui#ff#_filter_parent_winid
    call win_execute(winid,
          \ printf('call cursor(%d, %d) | normal! zb',
          \        a:line, a:col))
  endif
endfunction

function! ddu#ui#ff#_save_cursor() abort
  const text = '.'->getline()

  " NOTE: Skip save cursor if it is empty text.
  " Because the items are empty
  if text ==# '' && '$'->line() == 1
    return
  endif

  let b:ddu_ui_ff_save_cursor = #{
        \   pos: getcurpos(),
        \   text: text,
        \ }
endfunction

function! ddu#ui#ff#_echo(msg) abort
  echo a:msg
endfunction

function! ddu#ui#ff#_restore_cmdline(cmdline, cmdpos) abort
  call feedkeys(':' .. a:cmdline ..
        \ "\<Left>"->repeat(a:cmdline->strchars() - a:cmdpos + 1))
endfunction
