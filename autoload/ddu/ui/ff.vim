let s:namespace = has('nvim') ? nvim_create_namespace('ddu-ui-ff') : 0

function ddu#ui#ff#_update_buffer(
      \ params, bufnr, winid, lines, refreshed, pos) abort
  const current_lines = '$'->line(a:winid)

  call setbufvar(a:bufnr, '&modifiable', v:true)

  try
    " NOTE: deletebufline() changes cursor position.
    " NOTE: deletebufline() needs ":silent".
    const before_cursor = a:winid->getcurpos()
    if a:lines->empty()
      " Clear buffer
      if current_lines > 1
        silent call deletebufline(a:bufnr, 1, '$')
      else
        call setbufline(a:bufnr, 1, [''])
      endif
    else
      const footer_width = a:params.maxWidth / 3
      const lines = a:lines->map({ _, val ->
            \   ddu#ui#ff#_truncate(
            \     val, a:params.maxWidth, footer_width, '..')
            \ })
      call setbufline(a:bufnr, 1,
            \ a:params.reversed ? reverse(lines) : lines)

      if current_lines > lines->len()
        silent call deletebufline(a:bufnr, lines->len() + 1, '$')
      endif
    endif
  catch
    " NOTE: Buffer modify may be failed
    call ddu#util#print_error(v:exception)
    return
  finally
    call setbufvar(a:bufnr, '&modifiable', v:false)
    call setbufvar(a:bufnr, '&modified', v:false)
  endtry

  if !a:refreshed && a:winid->getcurpos() ==# before_cursor
    return
  endif

  " Init the cursor
  const lnum =
        \   a:pos <= 0
        \ ? before_cursor[1]
        \ : a:params.reversed
        \ ? a:lines->len() - a:pos
        \ : a:pos
  const win_height = a:winid->winheight()
  const max_line = '$'->line(a:winid)
  if max_line - lnum < win_height / 2
    " Adjust cursor position when cursor is near bottom.
    call win_execute(a:winid, 'normal! Gzb')
  endif
  call win_execute(a:winid, 'call cursor(' .. lnum .. ', 0)')
  if lnum < win_height / 2
    " Adjust cursor position when cursor is near top.
    call win_execute(a:winid, 'normal! zb')
  endif
endfunction

function ddu#ui#ff#_process_items(
      \ params, bufnr, max_lines, items, selected_items) abort
  " Buffer must be loaded
  if !a:bufnr->bufloaded()
    return
  endif

  " Clear all properties
  if has('nvim')
    call nvim_buf_clear_namespace(0, s:namespace, 0, -1)
  else
    call prop_clear(1, a:max_lines + 1, #{ bufnr: a:bufnr })
    for prop_type in prop_type_list(#{ bufnr: a:bufnr })
      call prop_type_delete(prop_type, #{ bufnr: a:bufnr })
    endfor
  endif

  const max_row = ddu#ui#ff#_max_row(a:bufnr)

  for item in a:items
    call s:add_info_texts(a:bufnr, item.info, item.row)

    let row = a:params.reversed ? a:max_lines - item.row + 1 : item.row
    let max_col = ddu#ui#ff#_max_col(a:bufnr, row)

    " Highlights items
    for hl in item.highlights
      call ddu#ui#ff#_highlight(
            \   hl.hl_group, hl.name, 1,
            \   s:namespace, a:bufnr,
            \   row,
            \   max_row,
            \   hl.col + item.prefix->strlen(),
            \   max_col,
            \   hl.width
            \ )
    endfor
  endfor

  " Selected items highlights
  let selected_highlight = a:params.highlights->get('selected', 'Statement')
  for item_nr in a:selected_items
    let row = a:params.reversed ? a:max_lines - item_nr : item_nr + 1
    let max_col = ddu#ui#ff#_max_col(a:bufnr, row)

    call ddu#ui#ff#_highlight(
          \   selected_highlight, 'ddu-ui-selected', 10000,
          \   s:namespace, a:bufnr,
          \   row,
          \   max_row,
          \   1,
          \   max_col,
          \   0
          \ )
  endfor

  " NOTE: :redraw is needed
  redraw
endfunction

function s:add_info_texts(bufnr, info, row) abort
  if a:row <= 0 || a:row > line('$')
    " Invalid range
    return
  endif

  if has('nvim')
    call nvim_buf_set_extmark(0, s:namespace, a:row - 1, 0, #{
          \   virt_lines: a:info->mapnew({ _, val ->
          \        val->has_key('hl_group')
          \      ? [[val.text, val.hl_group]]
          \      : [[val.text]]
          \   }),
          \ })
  else
    for index in a:info->len()->range()
      let info = a:info[index]
      let prop_type = 'ddu-ui-info-' .. a:row .. '-' .. index

      let prop_type_opts = #{
            \   bufnr: a:bufnr,
            \   priority: 10000,
            \   override: v:true,
            \ }
      if info->has_key('hl_group')
        let prop_type_opts.highlight = info.hl_group
      endif
      call prop_type_add(prop_type, prop_type_opts)

      call prop_add(a:row, 0, #{
            \   type: prop_type,
            \   text: info.text,
            \   text_align: 'below',
            \ })
    endfor
  endif
endfunction

function ddu#ui#ff#_max_row(bufnr)
  return a:bufnr->getbufinfo()
        \ ->get(0, #{ linecount: 0 })->get('linecount', 0)
endfunction

function ddu#ui#ff#_max_col(bufnr, row)
  return a:bufnr->getbufoneline(a:row)->len()
endfunction

function ddu#ui#ff#_highlight(
      \ highlight, prop_type, priority, id, bufnr,
      \ row, max_row, col, max_col, length) abort

  if !a:highlight->hlexists()
    call ddu#util#print_error(
          \ printf('highlight "%s" does not exist', a:highlight))
    return
  endif

  if a:row <= 0 || a:col <= 0 || a:row > a:max_row || a:col > a:max_col
    " Invalid range
    return
  endif

  const length =
        \   a:length <= 0 || a:col + a:length > a:max_col
        \ ? a:max_col - a:col + 1
        \ : a:length

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
    call nvim_buf_set_extmark(
          \   a:bufnr,
          \   a:id,
          \   a:row - 1,
          \   a:col - 1,
          \   #{
          \     end_col: a:col - 1 + length,
          \     hl_group: a:highlight,
          \   }
          \ )
  else
    call prop_add(a:row, a:col, #{
          \   length: length,
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
        const winid = nvim_open_win(
              \ a:preview_bufnr, a:params.previewFocusable, winopts)
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

function ddu#ui#ff#_update_cursor() abort
  let b:ddu_ui_ff_cursor_pos = getcurpos()

  call ddu#ui#update_cursor()
endfunction

function ddu#ui#ff#_restore_cmdline(cmdline, cmdpos) abort
  call feedkeys(':' .. a:cmdline ..
        \ "\<Left>"->repeat(a:cmdline->strchars() - a:cmdpos + 1))
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

  augroup ddu-ui-ff-auto_action
    autocmd!
  augroup END
endfunction
function ddu#ui#ff#_set_auto_action(winid, auto_action) abort
  const prev_winid = win_getid()
  let s:auto_action = a:auto_action
  let s:auto_action.bufnr = '%'->bufnr()

  call win_gotoid(a:winid)

  " NOTE: In action execution, auto action should be skipped
  augroup ddu-ui-ff-auto_action
    autocmd CursorMoved <buffer> ++nested
          \ : if !g:->get('ddu#ui#ff#_in_action', v:false)
          \ |   call ddu#ui#ff#_do_auto_action()
          \ | endif
  augroup END

  call win_gotoid(prev_winid)
endfunction

function s:do_auto_action() abort
  const bufnr = '%'->bufnr()
  if bufnr != s:auto_action.bufnr
    return
  endif

  const text = bufnr->getbufline(win_getid()->getcurpos()[1])->get(0, '')
  if text ==# s:cursor_text
    return
  endif
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

function ddu#ui#ff#_truncate(str, max, footer_width, separator) abort
  const width = a:str->strwidth()
  if width <= a:max
    const ret = a:str
  else
    const header_width = a:max - a:separator->strwidth() - a:footer_width
    const ret = s:strwidthpart(a:str, header_width) .. a:separator
         \ .. s:strwidthpart_reverse(a:str, a:footer_width)
  endif
  return s:truncate(ret, a:max)
endfunction
function s:truncate(str, width) abort
  " Original function is from mattn.
  " http://github.com/mattn/googlereader-vim/tree/master

  if a:str =~# '^[\x00-\x7f]*$'
    return a:str->len() < a:width
          \ ? printf('%-' .. a:width .. 's', a:str)
          \ : a:str->strpart(0, a:width)
  endif

  let ret = a:str
  let width = a:str->strwidth()
  if width > a:width
    let ret = s:strwidthpart(ret, a:width)
    let width = ret->strwidth()
  endif

  return ret
endfunction
function s:strwidthpart(str, width) abort
  const str = a:str->tr("\t", ' ')
  const vcol = a:width + 2
  return str->matchstr('.*\%<' .. (vcol < 0 ? 0 : vcol) .. 'v')
endfunction
function s:strwidthpart_reverse(str, width) abort
  const str = a:str->tr("\t", ' ')
  const vcol = str->strwidth() - a:width
  return str->matchstr('\%>' .. (vcol < 0 ? 0 : vcol) .. 'v.*')
endfunction
