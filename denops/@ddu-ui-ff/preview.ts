import {
  ActionFlags,
  BaseActionParams,
  BufferPreviewer,
  Context,
  DduItem,
  NoFilePreviewer,
  PreviewContext,
  Previewer,
  TerminalPreviewer,
} from "https://deno.land/x/ddu_vim@v3.2.3/types.ts";
import {
  batch,
  Denops,
  ensureObject,
  fn,
} from "https://deno.land/x/ddu_vim@v3.2.3/deps.ts";
import { replace } from "https://deno.land/x/denops_std@v5.0.0/buffer/mod.ts";
import { Params } from "../@ddu-uis/ff.ts";

type PreviewParams = {
  syntaxLimitChars?: number;
};

export class PreviewUi {
  private previewWinId = -1;
  private previewedTarget?: DduItem;
  private matchIds: Record<number, number> = {};
  private previewBufnrs: Set<number> = new Set();

  async close(denops: Denops, context: Context, uiParams: Params) {
    await this.clearHighlight(denops);

    if (this.previewWinId > 0 && (await fn.winnr(denops, "$")) !== 1) {
      if (uiParams.previewFloating && denops.meta.host !== "nvim") {
        await denops.call("popup_close", this.previewWinId);
      } else {
        const saveId = await fn.win_getid(denops);
        await batch(denops, async (denops) => {
          await fn.win_gotoid(denops, this.previewWinId);
          if (this.previewWinId === context.winId) {
            await denops.cmd(
              context.bufName === "" ? "enew" : `buffer ${context.bufNr}`,
            );
          } else {
            await denops.cmd("close!");
          }
          await fn.win_gotoid(denops, saveId);
        });
      }
      this.previewWinId = -1;
    }
    await batch(denops, async (denops) => {
      for (const bufnr of this.previewBufnrs) {
        await denops.cmd(
          `if bufexists(${bufnr}) | silent bwipeout! ${bufnr} | endif`,
        );
      }
    });
  }

  async execute(
    denops: Denops,
    command: string,
  ) {
    if (this.previewWinId < 0) {
      return;
    }
    await fn.win_execute(denops, this.previewWinId, command);
  }

  async previewContents(
    denops: Denops,
    context: Context,
    uiParams: Params,
    actionParams: unknown,
    getPreviewer: (
      denops: Denops,
      item: DduItem,
      actionParams: BaseActionParams,
      previewContext: PreviewContext,
    ) => Promise<Previewer | undefined>,
    bufnr: number,
    item: DduItem,
  ): Promise<ActionFlags> {
    const prevId = await fn.win_getid(denops);
    const previewParams = ensureObject(actionParams) as PreviewParams;

    // Close if the target is the same as the previous one
    if (
      this.previewWinId > 0 &&
      JSON.stringify(item) === JSON.stringify(this.previewedTarget)
    ) {
      await this.close(denops, context, uiParams);
      return ActionFlags.None;
    }

    // Adjustment for previewFloating.
    if (
      uiParams.previewFloating &&
      uiParams.previewFloatingBorder !== "none"
    ) {
      if (uiParams.floatingBorder !== "none") {
        uiParams.previewWidth -= 2;
      }
      uiParams.previewHeight -= 2;
    }

    const previewContext: PreviewContext = {
      col: uiParams.previewCol,
      row: uiParams.previewRow,
      width: uiParams.previewWidth,
      height: uiParams.previewHeight,
      isFloating: uiParams.previewFloating,
      split: uiParams.previewSplit,
    };
    const previewer = await getPreviewer(
      denops,
      item,
      actionParams as BaseActionParams,
      previewContext,
    );

    if (!previewer) {
      return ActionFlags.None;
    }

    let flag: ActionFlags;
    // Render the preview
    if (previewer.kind === "terminal") {
      flag = await this.previewContentsTerminal(
        denops,
        previewer,
        uiParams,
        bufnr,
        context.winId,
      );
    } else {
      flag = await this.previewContentsBuffer(
        denops,
        previewer,
        uiParams,
        previewParams,
        bufnr,
        context.winId,
        item,
      );
    }
    if (flag === ActionFlags.None) {
      return flag;
    }

    if (uiParams.previewFloating && denops.meta.host === "nvim") {
      const highlight = uiParams.highlights?.floating ?? "NormalFloat";
      const borderHighlight = uiParams.highlights?.floatingBorder ??
        "FloatBorder";
      const cursorLineHighlight = uiParams.highlights?.floatingCursorLine ??
        "CursorLine";
      await fn.setwinvar(
        denops,
        this.previewWinId,
        "&winhighlight",
        `Normal:${highlight},FloatBorder:${borderHighlight},CursorLine:${cursorLineHighlight}`,
      );
    }

    await this.jump(denops, previewer);

    if (uiParams.onPreview) {
      if (typeof uiParams.onPreview === "string") {
        await denops.call(
          "denops#callback#call",
          uiParams.onPreview,
          {
            context,
            item,
          },
        );
      } else {
        await uiParams.onPreview({
          denops,
          context,
          item,
          previewWinId: this.previewWinId,
        });
      }
    }

    const previewBufnr = await fn.bufnr(denops);
    this.previewBufnrs.add(previewBufnr);
    this.previewedTarget = item;
    await fn.win_gotoid(denops, prevId);

    return ActionFlags.Persist;
  }

  private async previewContentsTerminal(
    denops: Denops,
    previewer: TerminalPreviewer,
    uiParams: Params,
    bufnr: number,
    previousWinId: number,
  ): Promise<ActionFlags> {
    if (this.previewWinId < 0) {
      // Create new buffer
      const previewBufnr = await fn.bufadd(denops, "");
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, previewBufnr, "&buftype", "nofile");
        await fn.setbufvar(denops, previewBufnr, "&swapfile", 0);
        await fn.setbufvar(denops, previewBufnr, "&bufhidden", "hide");
      });
      this.previewWinId = await denops.call(
        "ddu#ui#ff#_open_preview_window",
        uiParams,
        bufnr,
        previewBufnr,
        previousWinId,
        this.previewWinId,
      ) as number;
    } else {
      await batch(denops, async (denops: Denops) => {
        await fn.win_gotoid(denops, this.previewWinId);
        // NOTE: Use enew! to ignore E948
        await denops.cmd("enew!");
      });
    }

    if (denops.meta.host === "nvim") {
      await denops.call("termopen", previewer.cmds);
    } else {
      await denops.call("term_start", previewer.cmds, {
        "curwin": true,
        "term_kill": "kill",
      });
    }

    return ActionFlags.Persist;
  }

  private async previewContentsBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    uiParams: Params,
    actionParams: PreviewParams,
    bufnr: number,
    previousWinId: number,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (
      previewer.kind === "nofile" && !previewer.contents?.length ||
      previewer.kind === "buffer" && !previewer.expr && !previewer.path
    ) {
      return ActionFlags.None;
    }

    const bufname = await this.getPreviewBufferName(denops, previewer, item);
    const exists = await fn.bufexists(denops, bufname);
    let previewBufnr = await fn.bufnr(denops, bufname);
    const text = await this.getContents(denops, previewer);
    if (!exists || previewer.kind === "nofile") {
      // Create new buffer
      previewBufnr = await fn.bufadd(denops, bufname);
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, previewBufnr, "&buftype", "nofile");
        await fn.setbufvar(denops, previewBufnr, "&swapfile", 0);
        await fn.setbufvar(denops, previewBufnr, "&bufhidden", "hide");
        await fn.setbufvar(denops, previewBufnr, "&modeline", 1);

        await fn.bufload(denops, previewBufnr);
        await replace(denops, previewBufnr, text);
      });
    }

    try {
      this.previewWinId = await denops.call(
        "ddu#ui#ff#_open_preview_window",
        uiParams,
        bufnr,
        previewBufnr,
        previousWinId,
        this.previewWinId,
      ) as number;
    } catch (_) {
      // Failed to open preview window
      return ActionFlags.None;
    }

    const limit = actionParams.syntaxLimitChars ?? 400000;
    if (text.join("\n").length < limit) {
      if (previewer.syntax) {
        await fn.setbufvar(denops, previewBufnr, "&syntax", previewer.syntax);
      } else if (previewer.kind === "buffer") {
        await fn.win_execute(denops, this.previewWinId, "filetype detect");
      }
    }

    // Set options
    await batch(denops, async (denops: Denops) => {
      for (const [option, value] of uiParams.previewWindowOptions) {
        await fn.setwinvar(denops, this.previewWinId, option, value);
      }
    });

    await this.highlight(
      denops,
      previewer,
      previewBufnr,
      uiParams.highlights?.preview ?? "Search",
    );
    return ActionFlags.Persist;
  }

  private async getPreviewBufferName(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    item: DduItem,
  ): Promise<string> {
    if (previewer.kind === "buffer") {
      if (previewer.expr) {
        const bufname = await fn.bufname(denops, previewer.expr);
        if (!bufname.length) {
          return `ddu-ff:no-name:${previewer.expr}`;
        } else {
          return `ddu-ff:${bufname}`;
        }
      } else {
        return `ddu-ff:${previewer.path}`;
      }
    } else if (previewer.kind === "nofile") {
      return `ddu-ff:preview`;
    } else {
      return `ddu-ff:${item.word}`;
    }
  }

  private async getContents(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
  ): Promise<string[]> {
    if (previewer.kind === "buffer") {
      const bufferPath = previewer?.expr ?? previewer?.path;
      if (
        previewer.path && await exists(previewer.path) &&
        !(await isDirectory(previewer.path))
      ) {
        const data = Deno.readFileSync(previewer.path);
        return new TextDecoder().decode(data).split("\n");
      } else if (bufferPath && await fn.bufexists(denops, bufferPath)) {
        // Use buffer instead.
        const bufnr = await fn.bufnr(denops, bufferPath);
        await fn.bufload(denops, bufnr);
        return await fn.getbufline(denops, bufnr, 1, "$");
      } else {
        return [
          "Error",
          `"${previewer.path}" cannot be opened.`,
        ];
      }
    } else {
      return previewer.contents;
    }
  }

  private async jump(denops: Denops, previewer: Previewer) {
    await batch(denops, async (denops: Denops) => {
      const hasPattern = "pattern" in previewer && previewer.pattern;
      const hasLineNr = "lineNr" in previewer && previewer.lineNr;

      if (hasPattern) {
        await fn.search(denops, previewer.pattern, "w");
      }
      if (hasLineNr && previewer.lineNr) {
        await fn.cursor(denops, [previewer.lineNr, 0]);
      }
      if (hasPattern || hasLineNr) {
        await denops.cmd("normal! zv");
        await denops.cmd("normal! zz");
      }
    });
  }

  private async highlight(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    bufnr: number,
    hlName: string,
  ) {
    // Clear the previous highlight
    await this.clearHighlight(denops);

    const winid = this.previewWinId;
    if (previewer?.lineNr) {
      this.matchIds[winid] = await fn.matchaddpos(denops, hlName, [
        previewer.lineNr,
      ]) as number;
    } else if (previewer?.pattern) {
      this.matchIds[winid] = await fn.matchadd(
        denops,
        hlName,
        previewer.pattern,
      ) as number;
    }

    const ns = denops.meta.host === "nvim"
      ? await denops.call("nvim_create_namespace", "ddu-ui-ff-preview")
      : 0;
    await batch(denops, async (denops) => {
      if (!previewer.highlights) {
        return;
      }

      for (const hl of previewer.highlights) {
        await denops.call(
          "ddu#ui#ff#_highlight",
          hl.hl_group,
          hl.name,
          1,
          ns,
          bufnr,
          hl.row,
          hl.col,
          hl.width,
        );
      }
    });
  }

  async clearHighlight(denops: Denops) {
    const winid = this.previewWinId;
    if (winid <= 0) {
      return;
    }

    if (this.matchIds[winid] > 0) {
      await fn.matchdelete(denops, this.matchIds[winid], winid);
      this.matchIds[winid] = -1;
    }
    if (denops.meta.host === "nvim") {
      const ns = await denops.call(
        "nvim_create_namespace",
        "ddu-ui-ff-preview",
      );
      await denops.call("nvim_buf_clear_namespace", 0, ns, 0, -1);
    } else {
      await denops.call(
        "prop_clear",
        1,
        await denops.call("line", "$", winid),
      );
    }
  }
}

const exists = async (path: string) => {
  // NOTE: Deno.stat() may be failed
  try {
    if (await Deno.stat(path)) {
      return true;
    }
  } catch (_e: unknown) {
    // Ignore
  }

  return false;
};

const isDirectory = async (path: string) => {
  // NOTE: Deno.stat() may be failed
  try {
    if ((await Deno.stat(path)).isDirectory) {
      return true;
    }
  } catch (_e: unknown) {
    // Ignore
  }

  return false;
};
