function! ddu#ui#std#filter#_open(name, input, bufnr, params) abort
  let ids = win_findbuf(a:bufnr)
  if !empty(ids)
    call win_gotoid(ids[0])
    call cursor(line('$'), 0)
  else
    call s:init_buffer(a:params)

    " Set the current input
    if getline('$') ==# ''
      call setline('$', a:input)
    else
      call append('$', a:input)
    endif
  endif

  augroup ddu-std-filter
    autocmd!
    autocmd InsertEnter,TextChangedI,TextChangedP,TextChanged,InsertLeave
          \ <buffer> call s:check_redraw()
  augroup END

  if a:params.prompt !=# ''
    setlocal signcolumn=yes
    call s:init_prompt(a:params.prompt, 'Special')
  else
    setlocal signcolumn=no
  endif

  call cursor(line('$'), 0)

  if has('nvim')
    startinsert!
  else
    " Note: startinsert! does not work in Vim
    call feedkeys('A', 'n')
  endif

  let s:filter_prev_input = getline('.')
  return bufnr('%')
endfunction

function! s:init_buffer(params) abort
  let is_floating =
        \ a:params.split ==# 'floating' ||
        \ a:params.filterSplitDirection ==# 'floating'

  if has('nvim') && is_floating
    let wincol = a:params.winCol
    let winrow = a:params.winRow
    let winwidth = a:params.winWidth
    let winheight = a:params.winHeight
    let winScreenpos = win_screenpos(win_getid())[0]
    let row = a:params.filterFloatingPosition == 'bottom'
          \ ? winScreenpos + winheight - 1
          \ : winScreenpos - 2
    if a:params.filterSplitDirection ==# 'floating'
      let wincol = win_screenpos(0)[1] - 1
    endif

    call nvim_open_win(bufnr('%'), v:true, {
          \ 'relative': 'editor',
          \ 'row': winrow == 1 ? 0 : row,
          \ 'col': wincol,
          \ 'width': winwidth,
          \ 'height': 1,
          \})
  else
    let direction = is_floating ? 'botright' : a:params.filterSplitDirection
    silent execute direction 'split'
  endif

  let bufnr = bufadd('ddu-std-filter')
  execute bufnr 'buffer'

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

  setfiletype ddu-std-filter
endfunction

let s:prompt_name = 'ddu_ui_std_filter_prompt'
function! s:init_prompt(prompt, highlight_prompt) abort

  call sign_define(s:prompt_name, {
        \ 'text': strwidth(a:prompt) > 2 ? ">" : a:prompt,
        \ 'texthl': a:highlight_prompt,
        \ })
  call s:update_prompt()

  augroup ddu-std-filter
    autocmd TextChangedI,TextChangedP,TextChanged <buffer>
          \ if s:sign_lnum != line('$') | call s:update_prompt() | endif
  augroup END
endfunction
function! s:update_prompt() abort
  let id = 2000
  call sign_unplace('', {'id': id, 'buffer': bufnr('%')})
  call sign_place(id, '', s:prompt_name, bufnr('%'), {'lnum': line('$')})
  let s:sign_lnum = line('$')
endfunction

function! s:check_redraw() abort
  let input = getline('.')

  if &filetype !=# 'ddu-std-filter'
        \ || input ==# s:filter_prev_input
    return
  endif

  let s:filter_prev_input = input

  call ddu#redraw(g:ddu#ui#std#_name, { 'input': input })
endfunction
