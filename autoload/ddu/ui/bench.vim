" Simple benchmark helper for ddu-ui-ff partial-update vs full-update.
" Place this file at autoload/ddu/ui/bench.vim in the repository.
"
" Usage (inside Neovim/Vim with plugin loaded):
"   :call ddu#ui#bench#Run(500, [0.05, 0.30, 1.00])
"   :call ddu#ui#bench#Run(1000, [0.05, 0.30, 1.00], 10, '~/ddu-bench.txt')
"
" Params:
" - total_lines: number of lines to generate (e.g. 500, 1000)
" - ratios: list of change ratios (0.05 == 5%, 0.30 == 30%, 1.00 == 100%)
" - iterations: optional number of repeats per test (default: 5)
" - outpath: optional file path to append results (default: none; results will
"   be echomsg)
"
if exists('g:loaded_ddu_ui_bench')
  finish
endif
let g:loaded_ddu_ui_bench = 1

function! ddu#ui#bench#_make_lines(n) abort
  let l:lines = []
  for i in range(1, a:n)
    " Keep each line long enough to include realistic content
    call add(l:lines, printf('line %d: %s', i, repeat('x', 64)))
  endfor
  return l:lines
endfunction

function! ddu#ui#bench#_mutate_lines(lines, ratio) abort
  let l:n = len(a:lines)
  if l:n == 0
    return a:lines
  endif
  let l:count = float2nr(l:n * a:ratio)
  " Deterministic pseudo-random index selection for repeatability
  for i in range(0, l:count - 1)
    let idx = (i * 2654435761) % l:n
    let a:lines[idx] = a:lines[idx] . ' [CHANGED]'
  endfor
  return a:lines
endfunction

" Compute single middle-run replace op: returns dict {start, end, lines}
" 1-indexed start/end for Vimscript consumers
function! ddu#ui#bench#_compute_single_replaceOp(prev, next) abort
  let n = len(a:prev)
  let m = len(a:next)
  " find common prefix length
  let i = 0
  while i < n && i < m && a:prev[i] ==# a:next[i]
    let i += 1
  endwhile
  " fully equal
  if i == n && i == m
    return {}
  endif
  " find common suffix length
  let j = n - 1
  let k = m - 1
  while j >= i && k >= i && a:prev[j] ==# a:next[k]
    let j -= 1
    let k -= 1
  endwhile
  " changed region in prev: i..j, in next: i..k
  let start = i + 1
  " if nothing in prev, end==start-1? keep at least start
  let end = (j >= i ? j + 1 : i)
  let lines = []
  if k >= i
    let lines = a:next[i : k]
  endif
  return { 'start': start, 'end': end, 'lines': lines }
endfunction

" Run a single measured action 'fn' for 'iters' times and return stats dict
function! ddu#ui#bench#_time_many(fn, iters) abort
  let times = []
  for _ in range(0, a:iters - 1)
    let t0 = reltime()
    call call(a:fn, [])
    let elapsed = reltimefloat(reltime(t0)) * 1000 " ms
    call add(times, elapsed)
  endfor
  " sort and compute stats
  call sort(times)
  let total = 0.0
  for v in times
    let total += v
  endfor
  let avg = total / max([1, len(times)])
  if len(times) == 0
    return {
          \ 'avg': avg,
          \ 'min': 0.0,
          \ 'max': 0.0,
          \ 'p75': 0.0,
          \ 'p99': 0.0,
          \ 'p995': 0.0,
          \ 'iters': 0,
          \ 'all': times,
          \ }
  endif

  let minv = times[0]
  let maxv = times[-1]

  " compute percentile indexes safely (convert to integer and clamp)
  let len_times = len(times)
  let idx75 = float2nr(floor(len_times * 0.75))
  let idx99 = float2nr(floor(len_times * 0.99))
  let idx995 = float2nr(floor(len_times * 0.995))

  if idx75 < 0
    let idx75 = 0
  elseif idx75 >= len_times
    let idx75 = len_times - 1
  endif
  if idx99 < 0
    let idx99 = 0
  elseif idx99 >= len_times
    let idx99 = len_times - 1
  endif
  if idx995 < 0
    let idx995 = 0
  elseif idx995 >= len_times
    let idx995 = len_times - 1
  endif

  let p75 = times[idx75]
  let p99 = times[idx99]
  let p995 = times[idx995]

  return {
        \ 'avg': avg,
        \ 'min': minv,
        \ 'max': maxv,
        \ 'p75': p75,
        \ 'p99': p99,
        \ 'p995': p995,
        \ 'iters': len(times),
        \ 'all': times,
        \ }
endfunction

" Core runner
function! ddu#ui#bench#Run(total_lines, ratios, ...) abort
  let iterations = a:0 >= 1 ? a:1[0] : 5
  let outpath = a:0 >= 2 ? a:1[1] : ''
  if a:0 >= 1
    let iterations = a:1
  endif
  if a:0 >= 2
    let outpath = a:2
  endif

  let bufnr = bufnr('%')
  if bufnr == -1
    enew
    let bufnr = bufnr('%')
  endif
  " make sure buffer is modifiable for these ops
  let save_mod = getbufvar(bufnr, '&modifiable', 1)
  call setbufvar(bufnr, '&modifiable', 1)

  let base = ddu#ui#bench#_make_lines(a:total_lines)

  for ratio in a:ratios
    " Make mutated lines for the test case
    let lines = copy(base)
    let lines = ddu#ui#bench#_mutate_lines(lines, ratio)

    " Full replace measurement (delete all + append)
    function! s:full_replace() abort
      let bn = bufnr('%')
      call deletebufline(bn, 1, '$')
      if len(g:bench_lines) > 0
        call appendbufline(bn, 0, g:bench_lines)
      endif
    endfunction
    let g:bench_lines = lines
    let res_full = ddu#ui#bench#_time_many(
          \ function('s:full_replace'), iterations)

    " Partial update measurement via ddu#ui#ff#_apply_operations if available
    " Build a simple single replace op from prev buffer contents to new lines
    " Read current buffer lines to act as 'prev'
    let prev_lines = getline(1, '$')
    " compute a single middle replace op
    let op = ddu#ui#bench#_compute_single_replaceOp(prev_lines, lines)
    if empty(op)
      " noop: measure an empty partial call
      function! s:partial_noop() abort
        return
      endfunction
      let res_part = ddu#ui#bench#_time_many(
            \ function('s:partial_noop'), iterations)
    else
      let s:ops = [
            \   {
            \     'op': 'replace_lines',
            \     'start': op.start,
            \     'end': op.end,
            \     'lines': op.lines,
            \   }
            \ ]
      function! s:partial_apply() abort
        call ddu#ui#ff#_apply_operations(bufnr('%'), s:ops)
      endfunction
      let g:bench_ops = s:ops
      let res_part = ddu#ui#bench#_time_many(
            \ function('s:partial_apply'), iterations)
    endif

    " Prepare report line
    let report = printf(
          \ 'bench: lines=%d ratio=%.2f iters=%d',
          \ a:total_lines, ratio, iterations)
    let report .= printf(
          \ ' full_avg=%.3fms full_p75=%.3fms full_p99=%.3fms',
          \ res_full.avg, res_full.p75, res_full.p99)
    if type(res_part) == type({})
      if has_key(res_part, 'avg')
        let report .= printf(
              \ ' partial_avg=%.3fms partial_p75=%.3fms partial_p99=%.3fms',
              \ res_part.avg, res_part.p75, res_part.p99)
      else
        let report .= ' partial=N/A'
      endif
    else
      let report .= ' partial=N/A'
    endif

    " Output
    if len(outpath) > 0
      call writefile([report], outpath, 'a')
    endif
    echomsg report
  endfor

  " restore modifiable flag
  call setbufvar(bufnr, '&modifiable', save_mod)
endfunction
