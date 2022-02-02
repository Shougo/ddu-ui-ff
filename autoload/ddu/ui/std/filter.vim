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
    autocmd WinClosed
          \ <buffer> call nvim_win_close(g:promptWin, v:true)
  augroup END

  call cursor(line('$'), 0)

  if has('nvim')
    startinsert!
  else
    " Note: startinsert! does not work in Vim
    call feedkeys('A', 'n')
  endif

  let g:ddu#ui#std#_filter_prev_input = getline('.')
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

    let prefixBuf = nvim_create_buf(v:false, v:true)
    call nvim_buf_set_lines(prefixBuf, 0, -1, v:true,
          \ [a:params.filterFloatingPrefix])
    let g:promptWin = nvim_open_win(prefixBuf, v:false, {
          \ 'relative': 'editor',
          \ 'row': winrow == 1 ? 0 : row,
          \ 'col': wincol,
          \ 'width': 2,
          \ 'height': 1,
          \ 'style': 'minimal',
          \ })

    call nvim_open_win(bufnr('%'), v:true, {
          \ 'relative': 'editor',
          \ 'row': winrow == 1 ? 0 : row,
          \ 'col': wincol + 2,
          \ 'width': winwidth - 2,
          \ 'height': 1,
          \})
  else
    let direction = is_floating ? 'botright' : a:params.filterSplitDirection
    silent execute direction 'split'
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

  call ddu#redraw(g:ddu#ui#std#_name, { 'input': input })
endfunction
