function ddu#ui#ff#filter#_open(input, params) abort
  let s:filter_prev_input = a:input
  let s:filter_updatetime = a:params.filterUpdateTime

  augroup ddu-ff-filter
    autocmd!
    autocmd CmdlineChanged <buffer> call s:check_update()
    autocmd User Ddu:ui:ff:openFilterWindow :
    autocmd User Ddu:ui:ff:closeFilterWindow :
  augroup END

  doautocmd User Ddu:ui:ff:openFilterWindow

  const input = exists('*cmdline#input') ?
        \ cmdline#input(a:params.prompt, a:input) :
        \ input(a:params.prompt, a:input)

  augroup ddu-ff-filter
    autocmd!
  augroup END
  let s:filter_prev_input = input
  doautocmd User Ddu:ui:ff:closeFilterWindow

  return input
endfunction

function s:check_update() abort
  if s:filter_updatetime > 0
    call ddu#ui#ff#_stop_debounce_timer('s:debounce_filter_update_timer')

    let s:debounce_filter_update_timer = timer_start(
          \ s:filter_updatetime, { -> s:check_redraw() })
  else
    call s:check_redraw()
  endif
endfunction
function s:check_redraw() abort
  const input = getcmdline()

  if input ==# s:filter_prev_input
    return
  endif

  let s:filter_prev_input = input

  call ddu#redraw(b:ddu_ui_name, #{ input: input })

  " NOTE: :redraw is needed
  redraw
endfunction
