# ddu-ui-std

Standard UI for ddu.vim

This UI is standard fuzzy finder.

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddu.vim

https://github.com/Shougo/ddu.vim

## Configuration

```vim
" Use std ui.
call ddu#custom#patch_global({
    \ 'ui': 'std',
    \ })
```
