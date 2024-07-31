let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-ff') : 0
let s:save_maps = {}

function ddu#ui#ff#save_cmaps(keys) abort
  let s:save_maps = {}
  for key in a:keys
    let s:save_maps[key] = key->maparg('c', v:false, v:true)
  endfor
endfunction
function ddu#ui#ff#restore_cmaps() abort
  for [key, map] in s:save_maps->items()
    " Remove current map
    let ff_map = key->maparg('c', v:false, v:true)
    if !ff_map->empty()
      if ff_map.buffer
        execute 'cunmap' '<buffer>' key
      else
        execute 'cunmap' key
      endif
    endif

    if !map->empty()
      " Restore old map
      call mapset('c', 0, map)
    endif
  endfor

  let s:save_maps = {}
endfunction

function ddu#ui#ff#_update_buffer(
      \ params, bufnr, lines, refreshed, pos) abort
  const winids = a:bufnr->win_findbuf()
  if winids->empty()
    return
  endif
  const winid = winids[0]
  const current_lines = '$'->line(winid)

  call setbufvar(a:bufnr, '&modifiable', v:true)

  " NOTE: deletebufline() changes cursor position.
  const before_cursor = winid->getcurpos()
  if a:lines->empty()
    " Clear buffer
    if current_lines > 1
      if '%'->bufnr() ==# a:bufnr
        silent % delete _
      else
        silent call deletebufline(a:bufnr, 1, '$')
      endif
    else
      call setbufline(a:bufnr, 1, [''])
    endif
  else
    call setbufline(a:bufnr, 1,
          \ a:params.reversed ? reverse(a:lines) : a:lines)

    if current_lines > a:lines->len()
      silent call deletebufline(a:bufnr, a:lines->len() + 1, '$')
    endif
  endif

  call setbufvar(a:bufnr, '&modifiable', v:false)
  call setbufvar(a:bufnr, '&modified', v:false)

  if !a:refreshed && winid->getcurpos() ==# before_cursor
    return
  endif

  " Init the cursor
  const lnum =
        \   a:pos <= 0
        \ ? before_cursor[1]
        \ : a:params.reversed
        \ ? a:lines->len() - a:pos
        \ : a:pos
  const win_height = winid->winheight()
  const max_line = '$'->line(winid)
  if max_line - lnum < win_height / 2
    " Adjust cursor position when cursor is near bottom.
    call win_execute(winid, 'normal! Gzb')
  endif
  call win_execute(winid, 'call cursor(' .. lnum .. ', 0)')
  if lnum < win_height / 2
    " Adjust cursor position when cursor is near top.
    call win_execute(winid, 'normal! zb')
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
            \ hl.col + item.prefix->strlen(), hl.width)
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

  " NOTE: :redraw is needed
  redraw
endfunction

function ddu#ui#ff#_highlight(
      \ highlight, prop_type, priority, id, bufnr, row, col, length) abort

  if !a:highlight->hlexists()
    call ddu#util#print_error(
          \ printf('highlight "%s" does not exists', a:highlight))
    return
  endif

  if !has('nvim')
    " Add prop_type
    if a:prop_type->prop_type_get(#{ bufnr: a:bufnr })->empty()
      call prop_type_add(a:prop_type, #{
            \   bufnr: a:bufnr,
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

  const use_winfixbuf =
        \ '+winfixbuf'->exists() && a:params.previewSplit !=# 'no'

  if a:preview_winid >= 0 && (!a:params.previewFloating || has('nvim'))
    call win_gotoid(a:preview_winid)

    if use_winfixbuf
      call setwinvar(a:preview_winid, '&winfixbuf', v:false)
    endif

    execute 'buffer' a:preview_bufnr

    if use_winfixbuf
      call setwinvar(a:preview_winid, '&winfixbuf', v:true)
    endif

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
  if use_winfixbuf
    call setwinvar(winid, '&winfixbuf', v:true)
  endif

  return winid
endfunction

let s:cursor_text = ''
let s:auto_action = {}
function ddu#ui#ff#_do_auto_action() abort
  call s:stop_debounce_timer('s:debounce_auto_action_timer')

  if empty(s:auto_action)
    return
  endif

  if mode() ==# 'c'
    " NOTE: In command line mode, timer_start() does not work
    call s:do_auto_action()
  else
    let s:debounce_auto_action_timer = timer_start(
          \ s:auto_action.delay, { -> s:do_auto_action() })
  endif
endfunction
function ddu#ui#ff#_reset_auto_action() abort
  let s:cursor_text = ''
  let s:auto_action = {}

  call s:stop_debounce_timer('s:debounce_auto_action_timer')

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

function ddu#ui#ff#_update_cursor() abort
  let b:ddu_ui_ff_cursor_pos = getcurpos()

  call ddu#ui#update_cursor()
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
          \ printf('call search(%s, "w")', a:pattern->string()))
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

function ddu#ui#ff#_open_filter_window(params, input, name, length) abort
  if !'s:filter_prev_input'->exists()
    let s:filter_prev_input = a:input
  endif
  let s:filter_init_input = a:input

  let b:ddu_ui_name = a:name

  augroup ddu-ui-ff-filter
    autocmd!
    autocmd User Ddu:ui:ff:openFilterWindow :
    autocmd User Ddu:ui:ff:closeFilterWindow :
  augroup END

  if a:params.filterUpdateMax <= 0 || a:length <= a:params.filterUpdateMax
    autocmd ddu-ui-ff-filter CmdlineChanged *
          \ ++nested call s:check_redraw(getcmdline())
  endif

  doautocmd User Ddu:ui:ff:openFilterWindow

  " NOTE: redraw is needed
  redraw

  const new_input = a:params.inputFunc->call([a:params.prompt, a:input])

  doautocmd User Ddu:ui:ff:closeFilterWindow

  augroup ddu-ui-ff-filter
    autocmd!
  augroup END

  call s:check_redraw(new_input)

  return new_input
endfunction

function s:check_redraw(input) abort
  if exists('s:filter_init_input')
    " Check s:filter_init_input
    " Because CmdlineChanged is called when default input
    if s:filter_init_input !=# '' && a:input !=# s:filter_init_input
      return
    endif

    unlet s:filter_init_input
  endif

  if a:input ==# s:filter_prev_input || !'b:ddu_ui_name'->exists()
    return
  endif

  let s:filter_prev_input = a:input

  call ddu#redraw(b:ddu_ui_name, #{ input: a:input })
endfunction

function s:do_auto_action() abort
  if &l:filetype !=# 'ddu-ff'
    return
  endif

  const winid = win_getid()
  const bufnr = winid->winbufnr()

  const text = bufnr->getbufline(winid->getcurpos()[1])->get(0, '')
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

function s:stop_debounce_timer(timer_name) abort
  if a:timer_name->exists()
    silent! call timer_stop({a:timer_name})
    unlet {a:timer_name}
  endif
endfunction
