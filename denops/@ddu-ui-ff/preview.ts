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
} from "https://deno.land/x/ddu_vim@v1.8.8/types.ts";
import {
  batch,
  Denops,
  ensureObject,
  fn,
} from "https://deno.land/x/ddu_vim@v1.8.8/deps.ts";
import { replace } from "https://deno.land/x/denops_std@v3.8.1/buffer/mod.ts";
import { Params } from "../@ddu-uis/ff.ts";

type PreviewParams = {
  syntaxLimitChars?: number;
};

type ActionData = Record<string, unknown>;

export class PreviewUi {
  private previewWinId = -1;
  private terminalBufnr = -1;
  private previewedTarget: ActionData = {};
  private matchIds: Record<number, number> = {};
  private previewBufnrs: Set<number> = new Set();

  async close(denops: Denops) {
    if (this.previewWinId > 0 && (await fn.winnr(denops, "$")) != 1) {
      const saveId = await fn.win_getid(denops);
      await batch(denops, async (denops) => {
        await fn.win_gotoid(denops, this.previewWinId);
        await denops.cmd("close!");
        await fn.win_gotoid(denops, saveId);
      });
      this.previewWinId = -1;
    }
    await batch(denops, async (denops) => {
      for (const bufnr of this.previewBufnrs) {
        await denops.cmd(
          `if buflisted(${bufnr}) | silent bwipeout! ${bufnr} | endif`,
        );
      }
    });
  }

  async preview(
    denops: Denops,
    _context: Context,
    options: DduOptions,
    uiParams: Params,
    actionParams: unknown,
    bufnr: number,
    item: DduItem,
  ): Promise<ActionFlags> {
    const action = item.action as ActionData;
    const prevId = await fn.win_getid(denops);
    const previewParams = ensureObject(actionParams) as PreviewParams;

    // Close if the target is the same as the previous one
    if (
      this.previewWinId > 0 &&
      JSON.stringify(action) == JSON.stringify(this.previewedTarget)
    ) {
      await this.close(denops);
      return ActionFlags.None;
    }

    const previewContext: PreviewContext = {
      col: uiParams.previewCol,
      row: uiParams.previewRow,
      width: uiParams.previewWidth,
      height: uiParams.previewHeight,
      isFloating: uiParams.previewFloating,
      isVertical: uiParams.previewVertical,
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
    if (previewer.kind == "terminal") {
      flag = await this.previewTerminal(
        denops,
        previewer,
        uiParams,
        bufnr,
      );
    } else {
      flag = await this.previewBuffer(
        denops,
        previewer,
        uiParams,
        previewParams,
        bufnr,
        item,
      );
    }
    if (flag == ActionFlags.None) {
      return flag;
    }

    await this.jump(denops, previewer);

    const previewBufnr = await fn.bufnr(denops);
    this.previewBufnrs.add(previewBufnr);
    this.previewedTarget = action;
    if (previewer.kind == "terminal") {
      this.terminalBufnr = bufnr;
    }
    await fn.win_gotoid(denops, prevId);

    return ActionFlags.Persist;
  }

  private async previewTerminal(
    denops: Denops,
    previewer: TerminalPreviewer,
    uiParams: Params,
    bufnr: number,
  ): Promise<ActionFlags> {
    if (this.previewWinId < 0) {
      await denops.call(
        "ddu#ui#ff#_open_preview_window",
        uiParams,
        bufnr,
      );
      this.previewWinId = await fn.win_getid(denops) as number;
    } else {
      await batch(denops, async (denops: Denops) => {
        await fn.win_gotoid(denops, this.previewWinId);
        await denops.cmd("enew");
      });
    }

    if (denops.meta.host == "nvim") {
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
          `if buflisted(${this.terminalBufnr}) | silent bwipeout! ${this.terminalBufnr} | endif`,
        );
        this.terminalBufnr = -1;
      } catch (e) {
        console.error(e);
      }
    }

    return ActionFlags.Persist;
  }

  private async previewBuffer(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    uiParams: Params,
    actionParams: PreviewParams,
    bufnr: number,
    item: DduItem,
  ): Promise<ActionFlags> {
    if (
      previewer.kind == "nofile" && !previewer.contents?.length ||
      previewer.kind == "buffer" && !previewer.expr && !previewer.path
    ) {
      return ActionFlags.None;
    }

    const bufname = await this.getPreviewBufferName(denops, previewer, item);
    const exists = await fn.buflisted(denops, bufname);
    if (this.previewWinId < 0) {
      await denops.call(
        "ddu#ui#ff#_open_preview_window",
        uiParams,
        bufnr,
      );
      this.previewWinId = await fn.win_getid(denops) as number;
    } else {
      await fn.win_gotoid(denops, this.previewWinId);
    }
    if (!exists) {
      await denops.cmd(`edit ${bufname}`);
      const text = await this.getPreviewContents(denops, previewer);
      const bufnr = await fn.bufnr(denops) as number;
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
        await replace(denops, bufnr, text);
        const limit = actionParams.syntaxLimitChars ?? 200000;
        if (text.join("\n").length < limit) {
          if (previewer.syntax) {
            await fn.setbufvar(denops, bufnr, "&syntax", previewer.syntax);
          } else if (previewer.kind == "buffer") {
            await denops.cmd("filetype detect");
          }
        }
      });
    } else {
      await denops.cmd(`buffer ${bufname}`);
    }

    const previewBufnr = await fn.bufnr(denops) as number;
    await this.highlight(denops, previewer, previewBufnr);
    return ActionFlags.Persist;
  }

  private async getPreviewBufferName(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    item: DduItem,
  ): Promise<string> {
    if (previewer.kind == "buffer") {
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

  private async getPreviewContents(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
  ): Promise<string[]> {
    if (previewer.kind == "buffer") {
      if (previewer.expr && await fn.buflisted(denops, previewer.expr)) {
        return await fn.getbufline(
          denops,
          await fn.bufnr(denops, previewer.expr),
          1,
          "$",
        );
      } else if (
        previewer.path && (await exists(previewer.path)) &&
        !(await isDirectory(previewer.path))
      ) {
        const data = Deno.readFileSync(previewer.path);
        return new TextDecoder().decode(data).split("\n");
      } else {
        return [];
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
  ) {
    const ns = denops.meta.host == "nvim"
      ? await denops.call("nvim_create_namespace", "ddu-ui-ff-preview")
      : 0;
    const winid = this.previewWinId;

    // Clear the previous highlight
    if (this.matchIds[winid] > 0) {
      await fn.matchdelete(denops, this.matchIds[winid], winid);
      this.matchIds[winid] = -1;
    }
    if (denops.meta.host == "nvim") {
      await denops.call("nvim_buf_clear_namespace", 0, ns, 0, -1);
    } else {
      await denops.call(
        "prop_clear",
        1,
        await denops.call("line", "$", winid),
      );
    }

    if (previewer?.lineNr) {
      this.matchIds[winid] = await fn.matchaddpos(denops, "Search", [
        previewer.lineNr,
      ]) as number;
    } else if (previewer?.pattern) {
      this.matchIds[winid] = await fn.matchadd(
        denops,
        "Search",
        previewer.pattern,
      ) as number;
    }

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
}

const exists = async (path: string) => {
  // Note: Deno.stat() may be failed
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
  // Note: Deno.stat() may be failed
  try {
    if ((await Deno.stat(path)).isDirectory) {
      return true;
    }
  } catch (_e: unknown) {
    // Ignore
  }

  return false;
};
