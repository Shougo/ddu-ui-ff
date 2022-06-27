function! ddu#ui#ff#filter#_open(name, input, bufnr, params) abort
  let parent_id = win_getid()

  let ids = win_findbuf(a:bufnr)
  if !empty(ids)
    call win_gotoid(ids[0])
    call cursor(line('$'), 0)
  else
    call s:init_buffer(a:name, a:params)

    " Set the current input
    if getline('$') ==# ''
      call setline('$', a:input)
    else
      call append('$', a:input)
    endif
  endif

  call cursor(line('$'), 0)

  augroup ddu-ff-filter
    autocmd!
    autocmd InsertEnter,TextChangedI,TextChangedP,TextChanged,InsertLeave
          \ <buffer> call s:check_update()
  augroup END

  " Disable backspace eol.
  let s:save_backspace = &backspace
  set backspace-=eol
  autocmd ddu-ff-filter BufLeave <buffer> ++once
        \ let &backspace = s:save_backspace

  " Disable whichwrap.
  let s:save_whichwrap = &whichwrap
  set whichwrap=
  autocmd ddu-ff-filter BufLeave <buffer> ++once
        \ let &whichwrap = s:save_whichwrap

  " Note: prompt must set after cursor move
  if a:params.prompt !=# ''
    setlocal signcolumn=yes
    call s:init_prompt(a:params.prompt,
          \ get(a:params.highlights, 'prompt', 'Special'))
  else
    setlocal signcolumn=no
  endif

  if has('nvim')
    startinsert!
  else
    " Note: startinsert! does not work in Vim
    call feedkeys('A', 'n')
  endif

  let s:filter_prev_input = getline('.')
  let s:filter_updatetime = a:params.filterUpdateTime
  let g:ddu#ui#ff#_filter_parent_winid = parent_id
  return bufnr('%')
endfunction

function! ddu#ui#ff#filter#_floating(bufnr, parent, params) abort
  let is_floating =
        \ a:params.split ==# 'floating' ||
        \ a:params.filterSplitDirection ==# 'floating'

  if !has('nvim') || !is_floating
    return
  endif

  let row = a:params.filterFloatingPosition ==# 'bottom'
        \ ? winheight(a:parent) : -1
  if a:params.floatingBorder isnot# 'none'
    if a:params.filterFloatingPosition ==# 'top'
      let row -= 2
    endif
  endif

  if a:params.split ==# 'floating'
    let row += a:params.winRow
    let col = a:params.winCol
  else
    let winpos = win_screenpos(a:parent)
    let row += winpos[0] - 1
    let col = winpos[1] - 1
  endif

  " Note: relative: win does not work for resume feature
  let params = {
        \ 'relative': 'editor',
        \ 'row': row,
        \ 'col': col,
        \ 'width': a:params.winWidth,
        \ 'height': 1,
        \ 'border': a:params.floatingBorder,
        \}
  if bufwinid(a:bufnr) > 0
    call nvim_win_set_config(bufwinid(a:bufnr), params)
  else
    " statusline must be set for floating window
    let statusline = &l:statusline
    let id = nvim_open_win(a:bufnr, v:true, params)
    call nvim_win_set_option(id, 'statusline', statusline)
  endif
endfunction

function! s:init_buffer(name, params) abort
  let is_floating =
        \ a:params.split ==# 'floating' ||
        \ a:params.filterSplitDirection ==# 'floating'

  let bufnr = bufadd('ddu-ff-filter-' . a:name)

  if has('nvim') && is_floating
    call ddu#ui#ff#filter#_floating(bufnr, win_getid(), a:params)
  else
    let direction = is_floating ? 'botright' : a:params.filterSplitDirection
    silent execute direction 'sbuffer' bufnr
  endif

  if has('nvim') && is_floating && has_key(a:params.highlights, 'floating')
    call setwinvar(bufwinnr(bufnr),
          \ '&winhighlight', a:params.highlights.floating)
  endif

  let b:ddu_ui_name = a:name

  setlocal bufhidden=hide
  setlocal buftype=nofile
  setlocal colorcolumn=
  setlocal foldcolumn=0
  setlocal nobuflisted
  setlocal nofoldenable
  setlocal nolist
  setlocal nomodeline
  setlocal nonumber
  setlocal norelativenumber
  setlocal nospell
  setlocal noswapfile
  setlocal nowrap
  setlocal winfixheight

  resize 1

  setfiletype ddu-ff-filter
endfunction

let s:prompt_name = 'ddu_ui_ff_filter_prompt'
function! s:init_prompt(prompt, highlight_prompt) abort
  call sign_define(s:prompt_name, {
        \ 'text': strwidth(a:prompt) > 2 ? '>' : a:prompt,
        \ 'texthl': a:highlight_prompt,
        \ })

  call s:update_prompt()

  augroup ddu-ff-filter
    autocmd TextChangedI,TextChangedP,TextChanged <buffer>
          \ if s:prev_lnum != line('$') | call s:update_prompt() | endif
  augroup END
endfunction
function! s:update_prompt() abort
  let id = 2000
  call sign_unplace('', {'id': id, 'buffer': bufnr('%')})
  call sign_place(id, '', s:prompt_name, bufnr('%'), {'lnum': line('.')})
  let s:prev_lnum = line('$')
endfunction

function! s:check_update() abort
  if s:filter_updatetime > 0
    if exists('s:update_timer')
      call timer_stop(s:update_timer)
    endif
    let s:update_timer = timer_start(
          \ s:filter_updatetime, {-> s:check_redraw()})
  else
    call s:check_redraw()
  endif
endfunction
function! s:check_redraw() abort
  unlet! s:update_timer

  let input = getline('.')

  if &l:filetype !=# 'ddu-ff-filter'
        \ || input ==# s:filter_prev_input
    return
  endif

  let s:filter_prev_input = input

  call ddu#redraw(b:ddu_ui_name, { 'input': input })
endfunction
