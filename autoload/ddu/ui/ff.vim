let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-ff') : 0

function ddu#ui#ff#do_action(name, options = {}) abort
  call ddu#util#print_error("ddu#ui#ff#do_action() is deprecated.")
  call ddu#util#print_error("Please use ddu#ui#do_action() instead.")
  return ddu#ui#do_action(a:name, a:options)
endfunction

function ddu#ui#ff#multi_actions(actions) abort
  call ddu#util#print_error("ddu#ui#ff#multi_actions() is deprecated.")
  call ddu#util#print_error("Please use ddu#ui#multi_actions() instead.")
  return ddu#ui#multi_actions(a:actions)
endfunction

function ddu#ui#ff#execute(command) abort
  if !'g:ddu#ui#ff#_filter_parent_winid'->exists()
    return
  endif

  const winid = g:ddu#ui#ff#_filter_parent_winid
  const prev_curpos = getcurpos(winid)

  call win_execute(winid, a:command)

  if 'g:ddu#ui#ff#_save_title'->exists()
    call ddu#ui#ff#_set_title(winid->winbufnr(), winid)
  endif

  if getcurpos(winid) != prev_curpos
    " NOTE: CursorMoved autocmd does not work when win_execute()

    call ddu#ui#ff#_stop_debounce_timer('s:debounce_cursor_moved_timer')

    let s:debounce_cursor_moved_timer = timer_start(
          \ 100, { -> s:do_cursor_moved(winid) })
  endif
endfunction

function ddu#ui#ff#_update_buffer(
      \ params, bufnr, winid, lines, refreshed, pos) abort
  const current_lines = '$'->line(a:winid)

  call setbufvar(a:bufnr, '&modifiable', 1)

  " NOTE: deletebufline() changes cursor position.
  let changed_cursor = v:false
  if a:lines->empty()
    " Clear buffer
    if current_lines > 1
      if '%'->bufnr() ==# a:bufnr
        silent % delete _
      else
        silent call deletebufline(a:bufnr, 1, '$')
      endif

      let changed_cursor = v:true
    else
      call setbufline(a:bufnr, 1, [''])
    endif
  else
    call setbufline(a:bufnr, 1,
          \ a:params.reversed ? reverse(a:lines) : a:lines)

    if current_lines > a:lines->len()
      silent call deletebufline(a:bufnr, a:lines->len() + 1, '$')
      let changed_cursor = v:true
    endif
  endif

  call setbufvar(a:bufnr, '&modifiable', 0)
  call setbufvar(a:bufnr, '&modified', 0)

  if !a:refreshed && !changed_cursor
    return
  endif

  " Init the cursor
  const curpos = getcurpos(a:winid)
  const lnum = a:params.reversed ? a:lines->len() - a:pos : a:pos + 1
  if curpos[1] != lnum
    call win_execute(a:winid,
          \ printf('call cursor(%d, 0) | normal! zb', lnum))
  elseif a:params.reversed
    call win_execute(a:winid, 'normal! zb')
  endif
endfunction

function ddu#ui#ff#_highlight_items(
      \ params, bufnr, max_lines, highlight_items, selected_items) abort
  " Buffer must be loaded
  if !a:bufnr->bufloaded()
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
          \ s:namespace, a:bufnr,
          \ a:params.reversed ? a:max_lines - item_nr : item_nr + 1,
          \ 1, 1000)
  endfor

  if !has('nvim')
    " NOTE: :redraw is needed for Vim
    redraw
  endif
endfunction

function ddu#ui#ff#_highlight(
      \ highlight, prop_type, priority, id, bufnr, row, col, length) abort
  if !has('nvim')
    " Add prop_type
    if a:prop_type->prop_type_get()->empty()
      call prop_type_add(a:prop_type, #{
            \   highlight: a:highlight,
            \   priority: a:priority,
            \   override: v:true,
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

function ddu#ui#ff#_open_preview_window(
      \ params, bufnr, preview_bufnr, prev_winid, preview_winid) abort
  if a:preview_winid >= 0 && (!a:params.previewFloating || has('nvim'))
    call win_gotoid(a:preview_winid)
    execute 'buffer' a:preview_bufnr
    return a:preview_winid
  endif

  let preview_width = a:params.previewWidth
  let preview_height = a:params.previewHeight
  const winnr = a:bufnr->bufwinid()
  const pos = winnr->win_screenpos()
  const win_width = winnr->winwidth()
  const win_height = winnr->winheight()

  if a:params.previewSplit ==# 'vertical'
    if a:params.previewFloating
      let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
      let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1

      if a:params.previewRow <= 0 && win_row <= preview_height
        let win_col += win_width
        if (win_col + preview_width) > &columns
          let win_col -= preview_width
        endif
      endif

      if a:params.previewCol <= 0 && a:params.previewFloatingBorder !=# 'none'
        let preview_width -= 1
      endif

      if has('nvim')
        let winopts = #{
              \   relative: 'editor',
              \   row: win_row,
              \   col: win_col,
              \   width: preview_width,
              \   height: preview_height,
              \   border: a:params.previewFloatingBorder,
              \   title: a:params.previewFloatingTitle,
              \   title_pos: a:params.previewFloatingTitlePos,
              \   zindex: a:params.previewFloatingZindex,
              \ }
        if !has('nvim-0.9.0')
          " NOTE: "title" and "title_pos" needs neovim 0.9.0+
          call remove(winopts, 'title')
          call remove(winopts, 'title_pos')
        endif
        const winid = nvim_open_win(a:preview_bufnr, v:true, winopts)
      else
        const winopts = #{
              \   pos: 'topleft',
              \   posinvert: v:false,
              \   line: win_row + 1,
              \   col: win_col + 1,
              \   border: [],
              \   borderchars: [],
              \   borderhighlight: [],
              \   highlight: 'Normal',
              \   maxwidth: preview_width,
              \   minwidth: preview_width,
              \   maxheight: preview_height,
              \   minheight: preview_height,
              \   scrollbar: 0,
              \   title: a:params.previewFloatingTitle,
              \   wrap: 0,
              \   zindex: a:params.previewFloatingZindex,
              \ }
        if a:preview_winid >= 0
          call popup_close(a:preview_winid)
        endif
        const winid = a:preview_bufnr->popup_create(winopts)
      endif
    else
      call win_gotoid(winnr)
      execute 'silent rightbelow vertical sbuffer' a:preview_bufnr
      setlocal winfixwidth
      execute 'vertical resize' preview_width
      const winid = win_getid()
    endif
  elseif a:params.previewSplit ==# 'horizontal'
    if a:params.previewFloating
      let win_row = a:params.previewRow > 0 ?
              \ a:params.previewRow : pos[0] - 1
      let win_col = a:params.previewCol > 0 ?
              \ a:params.previewCol : pos[1] - 1

      if a:params.previewRow <= 0 && a:params.previewFloatingBorder !=# 'none'
        let preview_height -= 1
      endif

      if a:params.previewRow <= 0 && a:params.filterFloatingPosition ==# 'top'
        let preview_height -= 1
        let win_row -= 1
      endif

      if has('nvim')
        if a:params.previewRow <= 0 && win_row <= preview_height
          let win_row += win_height + 1
          const anchor = 'NW'
        else
          const anchor = 'SW'
        endif

        let winopts = #{
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
              \ }
        if !has('nvim-0.9.0')
          " NOTE: "title" and "title_pos" needs neovim 0.9.0+
          call remove(winopts, 'title')
          call remove(winopts, 'title_pos')
        endif
        const winid = nvim_open_win(a:preview_bufnr, v:true, winopts)
      else
        if a:params.previewRow <= 0
          let win_row -= preview_height + 2
        endif
        const winopts = #{
              \   pos: 'topleft',
              \   posinvert: v:false,
              \   line: win_row + 1,
              \   col: win_col + 1,
              \   border: [],
              \   borderchars: [],
              \   borderhighlight: [],
              \   highlight: 'Normal',
              \   maxwidth: preview_width,
              \   minwidth: preview_width,
              \   maxheight: preview_height,
              \   minheight: preview_height,
              \   scrollbar: 0,
              \   title: a:params.previewFloatingTitle,
              \   wrap: 0,
              \   zindex: a:params.previewFloatingZindex,
              \ }
        if a:preview_winid >= 0
          call popup_close(a:preview_winid)
        endif
        const winid = a:preview_bufnr->popup_create(winopts)
      endif
    else
      " NOTE: If winHeight is bigger than `&lines / 2`, it will be resized.
      const maxheight = &lines * 4 / 10
      if preview_height > maxheight
        let preview_height = maxheight
      endif

      call win_gotoid(winnr)
      execute 'silent aboveleft sbuffer' a:preview_bufnr
      setlocal winfixheight
      execute 'resize ' .. preview_height
      const winid = win_getid()
    endif
  elseif a:params.previewSplit ==# 'no'
    call win_gotoid(a:prev_winid)
    execute 'buffer' a:preview_bufnr
    const winid = win_getid()
  endif

  " Set options
  if a:params.previewSplit !=# 'no'
    call setwinvar(winid, '&previewwindow', v:true)
  endif
  call setwinvar(winid, '&cursorline', v:false)

  return winid
endfunction

let s:cursor_text = ''
let s:auto_action = {}
function ddu#ui#ff#_do_auto_action() abort
  call ddu#ui#ff#_stop_debounce_timer('s:debounce_auto_action_timer')

  if empty(s:auto_action)
    return
  endif

  let s:debounce_auto_action_timer = timer_start(
        \ s:auto_action.delay, { -> s:do_auto_action() })
endfunction
function ddu#ui#ff#_reset_auto_action() abort
  let s:cursor_text = ''
  let s:auto_action = {}

  call ddu#ui#ff#_stop_debounce_timer('s:debounce_auto_action_timer')

  augroup ddu-ui-auto_action
    autocmd!
  augroup END
endfunction
function ddu#ui#ff#_set_auto_action(winid, auto_action) abort
  const prev_winid = win_getid()
  let s:auto_action = a:auto_action

  call win_gotoid(a:winid)

  " NOTE: In action execution, auto action should be skipped
  augroup ddu-ui-auto_action
    autocmd CursorMoved <buffer> ++nested
          \ : if !g:->get('ddu#ui#ff#_in_action', v:false)
          \ |   call ddu#ui#ff#_do_auto_action()
          \ | endif
  augroup END

  call win_gotoid(prev_winid)
endfunction

function ddu#ui#ff#_cursor(line, col) abort
  if &l:filetype ==# 'ddu-ff'
        \ || !'g:ddu#ui#ff#_filter_parent_winid'->exists()
    call cursor(a:line, a:col)
  else
    call ddu#ui#ff#execute(printf('call cursor(%d, %d) | redraw', a:line, a:col))
    redraw
  endif
endfunction

function ddu#ui#ff#_save_cursor(bufnr='%'->bufnr(), pos=getcurpos()) abort
  const text = getbufline(a:bufnr, a:pos[1])

  " NOTE: Skip save cursor if it is empty text.
  " Because the items are empty
  if '$'->line() ==# 1 && (empty(text) || text[0] ==# '')
    return
  endif

  call setbufvar(a:bufnr, 'ddu_ui_ff_save_cursor_item', ddu#ui#get_item())
endfunction

function ddu#ui#ff#_echo(msg) abort
  echo a:msg
endfunction

function ddu#ui#ff#_restore_cmdline(cmdline, cmdpos) abort
  call feedkeys(':' .. a:cmdline ..
        \ "\<Left>"->repeat(a:cmdline->strchars() - a:cmdpos + 1))
endfunction

function ddu#ui#ff#_restore_title() abort
  if !'g:ddu#ui#ff#_save_title'->exists()
    return
  endif

  let &titlestring = g:ddu#ui#ff#_save_title
endfunction
function ddu#ui#ff#_set_title(bufnr, winid=win_getid()) abort
  const title = getbufvar(a:bufnr, 'ddu_ui_ff_title', '')
  if title ==# '' || &titlestring ==# title
    return
  endif

  const linenr = "printf('%'.(len(line('$', "
        \ .. a:winid .. "))).'d/%d',line('.', "
        \ .. a:winid .. "),line('$', " .. a:winid .. "))"
  let &titlestring = printf('%s %%{%s}', title, linenr)
endfunction

function ddu#ui#ff#_jump(winid, pattern, linenr) abort
  if a:pattern !=# ''
    call win_execute(a:winid,
          \ printf('call search(%s, "w")', string(a:pattern)))
  endif

  if a:linenr > 0
    call win_execute(a:winid,
          \ printf('call cursor(%d, 0)', a:linenr))
  endif

  if a:pattern !=# '' || a:linenr > 0
    call win_execute(a:winid, 'normal! zv')
    call win_execute(a:winid, 'normal! zz')
  endif
endfunction

function ddu#ui#ff#_stop_debounce_timer(timer_name) abort
  if a:timer_name->exists()
    silent! call timer_stop({a:timer_name})
    unlet {a:timer_name}
  endif
endfunction

function s:do_cursor_moved(winid) abort
  const prev_winid = win_getid()
  try
    call win_gotoid(a:winid)

    silent doautocmd CursorMoved
  finally
    call win_gotoid(prev_winid)
  endtry
endfunction

function s:do_auto_action() abort
  const winid = (&l:filetype ==# 'ddu-ff'
        \        || !'g:ddu#ui#ff#_filter_parent_winid'->exists())
        \ ? win_getid() : g:ddu#ui#ff#_filter_parent_winid
  const bufnr = winid->winbufnr()

  const text = bufnr->getbufline(getcurpos(winid)[1])->get(0, '')
  if text ==# s:cursor_text
    return
  endif

  if s:auto_action.sync
    call ddu#ui#sync_action(s:auto_action.name, s:auto_action.params)
  else
    call ddu#ui#do_action(s:auto_action.name, s:auto_action.params)
  endif
  let s:cursor_text = text
endfunction
