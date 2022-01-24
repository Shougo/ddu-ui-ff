let g:ddu#ui#std#_filter_name = ''

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
          \ <buffer> call s:update()
  augroup END

  call cursor(line('$'), 0)
  startinsert!

  let g:ddu#ui#std#_filter_prev_input = getline('.')
  let g:ddu#ui#std#_filter_name = a:name
  return bufnr('%')
endfunction

function! s:init_buffer(params) abort
  if has('nvim') && a:params.split ==# 'floating'
    let wincol = &columns / 4
    let winrow = &lines / 2 - 10
    let winwidth = &columns / 2
    let row = win_screenpos(win_getid())[0] - 1
    let bordered_row = row + winheight(0)

    call nvim_open_win(bufnr('%'), v:true, {
          \ 'relative': 'editor',
          \ 'row': winrow == 1 ? 0 : bordered_row,
          \ 'col': wincol,
          \ 'width': winwidth,
          \ 'height': 1,
          \})
  else
    split
  endif

  let bufnr = bufadd('ddu-std-filter')
  execute bufnr 'buffer'

  let g:ddu#ui#std#_filter_winid = win_getid()

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
  setlocal signcolumn=auto
  setlocal winfixheight

  resize 1

  setfiletype ddu-std-filter
endfunction

function! s:update() abort
  let input = getline('.')

  if &filetype !=# 'ddu-std-filter'
        \ || input ==# g:ddu#ui#std#_filter_prev_input
    return
  endif

  let g:ddu#ui#std#_filter_prev_input = input

  call ddu#narrow(g:ddu#ui#std#_filter_name, input)
endfunction
