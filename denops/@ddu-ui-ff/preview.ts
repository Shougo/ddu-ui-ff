import {
  ActionFlags,
  BufferPreviewer,
  Context,
  DduItem,
  DduOptions,
  NoFilePreviewer,
  PreviewContext,
  Previewer,
  TerminalPreviewer,
} from "https://deno.land/x/ddu_vim@v2.8.4/types.ts";
import {
  batch,
  Denops,
  ensureObject,
  fn,
  op,
} from "https://deno.land/x/ddu_vim@v2.8.4/deps.ts";
import { replace } from "https://deno.land/x/denops_std@v4.3.3/buffer/mod.ts";
import { Params } from "../@ddu-uis/ff.ts";

type PreviewParams = {
  syntaxLimitChars?: number;
};

export class PreviewUi {
  private previewWinId = -1;
  private terminalBufnr = -1;
  private previewedTarget?: DduItem;
  private matchIds: Record<number, number> = {};
  private previewBufnrs: Set<number> = new Set();

  async close(denops: Denops, context: Context) {
    await this.clearHighlight(denops);

    if (this.previewWinId > 0 && (await fn.winnr(denops, "$")) !== 1) {
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

  async previewContents(
    denops: Denops,
    context: Context,
    options: DduOptions,
    uiParams: Params,
    actionParams: unknown,
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
      await this.close(denops, context);
      return ActionFlags.None;
    }

    const previewContext: PreviewContext = {
      col: uiParams.previewCol,
      row: uiParams.previewRow,
      width: uiParams.previewWidth,
      height: uiParams.previewHeight,
      isFloating: uiParams.previewFloating,
      split: uiParams.previewSplit,
    };
    const previewer = await denops.call(
      "ddu#get_previewer",
      options.name,
      item,
      actionParams,
      previewContext,
    ) as Previewer | undefined;

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

    if (uiParams.previewFloating) {
      const highlight = uiParams.highlights?.floating ?? "NormalFloat";
      const borderHighlight = uiParams.highlights?.floatingBorder ??
        "FloatBorder";
      await fn.setwinvar(
        denops,
        this.previewWinId,
        "&winhighlight",
        `Normal:${highlight},FloatBorder:${borderHighlight}`,
      );
    }

    await this.jump(denops, previewer);

    const previewBufnr = await fn.bufnr(denops);
    this.previewBufnrs.add(previewBufnr);
    this.previewedTarget = item;
    if (previewer.kind === "terminal") {
      this.terminalBufnr = bufnr;
    }
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
      await denops.call(
        "ddu#ui#ff#_open_preview_window",
        uiParams,
        bufnr,
        previousWinId,
      );
      this.previewWinId = await fn.win_getid(denops) as number;
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

    // Delete the previous buffer after opening new one to prevent flicker
    if (this.terminalBufnr > 0) {
      try {
        await denops.cmd(
          `if bufexists(${this.terminalBufnr}) | silent bwipeout! ${this.terminalBufnr} | endif`,
        );
        this.terminalBufnr = -1;
      } catch (e) {
        console.error(e);
      }
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
    if (this.previewWinId < 0) {
      try {
        await denops.call(
          "ddu#ui#ff#_open_preview_window",
          uiParams,
          bufnr,
          previousWinId,
        );
      } catch (_) {
        // Failed to open preview window
        return ActionFlags.None;
      }

      this.previewWinId = await fn.win_getid(denops) as number;
    } else {
      await fn.win_gotoid(denops, this.previewWinId);
    }
    if (!exists) {
      // Create new buffer
      const bufnr = await fn.bufadd(denops, bufname);
      const text = await this.getContents(denops, previewer);
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
        await fn.setbufvar(denops, bufnr, "&swapfile", 0);
        await fn.setbufvar(denops, bufnr, "&bufhidden", "wipe");

        await fn.bufload(denops, bufnr);
        await denops.cmd(`buffer ${bufnr}`);
        await replace(denops, bufnr, text);
        const limit = actionParams.syntaxLimitChars ?? 200000;
        if (text.join("\n").length < limit) {
          if (previewer.syntax) {
            await fn.setbufvar(denops, bufnr, "&syntax", previewer.syntax);
          } else if (previewer.kind === "buffer") {
            await denops.cmd("filetype detect");
          }
        }
      });
    } else {
      const bufnr = await fn.bufnr(denops, bufname) as number;
      await denops.cmd(`buffer ${bufnr}`);
    }

    // Set options
    await batch(denops, async (denops: Denops) => {
      for (const [option, value] of uiParams.previewWindowOptions) {
        await fn.setwinvar(denops, this.previewWinId, option, value);
      }
    });

    if (uiParams.previewSplit !== "no") {
      // Set previewwindow option.
      await op.previewwindow.setLocal(denops, true);
    }

    const previewBufnr = await fn.bufnr(denops) as number;
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
    } else {
      return `ddu-ff:${item.word}`;
    }
  }

  private async getContents(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
  ): Promise<string[]> {
    if (previewer.kind === "buffer") {
      if (previewer.expr && await fn.bufexists(denops, previewer.expr)) {
        return await fn.getbufline(
          denops,
          await fn.bufnr(denops, previewer.expr),
          1,
          "$",
        );
      } else if (
        previewer.path && await exists(previewer.path) &&
        !(await isDirectory(previewer.path))
      ) {
        const data = Deno.readFileSync(previewer.path);
        return new TextDecoder().decode(data).split("\n");
      } else if (
        previewer.path && await fn.bufexists(denops, previewer.path)
      ) {
        // Use buffer instead.
        return await fn.getbufline(
          denops,
          await fn.bufnr(denops, previewer.path),
          1,
          "$",
        );
      } else {
        return [`"${previewer.path}" cannot be opened.`];
      }
    } else {
      return previewer.contents;
    }
  }

  private async jump(denops: Denops, previewer: Previewer) {
    await batch(denops, async (denops: Denops) => {
      if ("pattern" in previewer && previewer.pattern) {
        await fn.search(denops, previewer.pattern, "w");
      }
      if ("lineNr" in previewer && previewer.lineNr) {
        await fn.cursor(denops, [previewer.lineNr, 0]);
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
