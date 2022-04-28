import {
  ActionFlags,
  BufferPreviewer,
  Context,
  DduItem,
  DduOptions,
  NoFilePreviewer,
  Previewer,
  TermPreviewer,
} from "../../../ddu.vim/denops/ddu/types.ts";
import {
  batch,
  Denops,
  fn,
  gather,
} from "https://deno.land/x/ddu_vim@v1.5.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.3.0/file.ts";
import { replace } from "https://deno.land/x/denops_std@v3.3.0/buffer/mod.ts";
import { Params } from "../@ddu-uis/ff.ts";

export class PreviewUi {
  private previewWinId = -1;
  private terminalBufnr = -1;
  private previewedTarget: ActionData = {};
  private matchIds: Record<number, number> = {};
  private previewBufnrs: Set<number> = new Set();

  async close(denops: Denops) {
    if (this.previewWinId > 0) {
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
        await denops.cmd(`if buflisted(${bufnr}) | bdelete! ${bufnr}  | endif`);
      }
    });
  }

  async preview(
    denops: Denops,
    _context: Context,
    options: DduOptions,
    uiParams: Params,
    actionParams: unknown,
    item: DduItem,
  ): Promise<ActionFlags> {
    const action = item.action as ActionData;
    const prevId = await fn.win_getid(denops);

    // close if the target is the same as the previous one
    if (
      this.previewWinId > 0 &&
      JSON.stringify(action) == JSON.stringify(this.previewedTarget)
    ) {
      await this.close(denops);
      return Promise.resolve(ActionFlags.None);
    }

    const previewer = await denops.dispatch(
      "ddu",
      "getPreviewer",
      options.name,
      item,
      actionParams,
    ) as Previewer;

    if (!previewer) {
      return Promise.resolve(ActionFlags.None);
    }

    let flag: ActionFlags;
    // render preview
    if (previewer.kind == "terminal") {
      flag = await this.previewTerminal(denops, previewer, uiParams);
    } else {
      flag = await this.previewBuffer(denops, previewer, uiParams, item);
    }
    if (flag == ActionFlags.None) {
      return flag;
    }
    const [winid, bufnr] = await gather(denops, async (denops) => {
      await fn.win_getid(denops);
      await fn.bufnr(denops);
    }) as [number, number];

    await this.jump(denops, previewer);
    await this.highlight(denops, previewer, winid);

    this.previewWinId = winid;
    // this.previewBufnr = await fn.bufnr(denops);
    this.previewBufnrs.add(bufnr);
    this.previewedTarget = action;
    await fn.win_gotoid(denops, prevId);

    return Promise.resolve(ActionFlags.Persist);
  }

  private async previewTerminal(
    denops: Denops,
    previewer: TermPreviewer,
    uiParams: Params,
  ): Promise<ActionFlags> {
    if (this.previewWinId < 0) {
      await denops.call(
        "ddu#ui#ff#_preview_file",
        uiParams,
        "",
      );
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
    // delete previous buffer after opening new one to prevent flicker
    if (
      this.terminalBufnr > 0 &&
      (await fn.bufexists(denops, this.terminalBufnr))
    ) {
      try {
        await denops.cmd(`bdelete! ${this.terminalBufnr}`);
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
    item: DduItem,
  ): Promise<ActionFlags> {
    if (
      previewer.kind == "nofile" && !previewer.contents?.length ||
      previewer.kind == "buffer" && !previewer.expr && !previewer.path
    ) {
      return Promise.resolve(ActionFlags.None);
    }
    const bufname = await this.getPreviewBufferName(denops, previewer, item);
    const exists = await fn.bufexists(denops, bufname);
    if (this.previewWinId < 0) {
      await denops.call(
        "ddu#ui#ff#_preview_file",
        uiParams,
        "",
      );
    } else {
      await fn.win_gotoid(denops, this.previewWinId);
    }
    if (!exists) {
      await denops.cmd(`edit ${bufname}`);
      const bufnr = await fn.bufnr(denops) as number;
      const text = await this.getPreviewContents(denops, previewer);
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
        await replace(denops, bufnr, text);
        await denops.cmd("filetype detect");
      });
    } else {
      await denops.cmd(`buffer ${bufname}`);
    }
    return ActionFlags.Persist;
  }

  private async getPreviewBufferName(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
    item: DduItem,
  ): Promise<string> {
    if (previewer.kind == "buffer") {
      return `ddu-ff:${
        previewer.expr
          ? await fn.bufname(
            denops,
            previewer.expr,
          )
          : previewer.path
      }`;
    } else {
      return `ddu-ff:${item.word}`;
    }
  }

  private async getPreviewContents(
    denops: Denops,
    previewer: BufferPreviewer | NoFilePreviewer,
  ): Promise<string[]> {
    if (previewer.kind == "buffer") {
      if (previewer.expr && await fn.bufexists(denops, previewer.expr)) {
        return await fn.getbufline(
          denops,
          await fn.bufnr(denops, previewer.expr),
          1,
          "$",
        );
      } else {
        const data = Deno.readFileSync(previewer.path);
        return new TextDecoder().decode(data).split("\n");
      }
    } else {
      return previewer.contents;
    }
  }

  private async jump(denops: Denops, previewer: Previewer) {
    await batch(denops, async (denops: Denops) => {
      if (previewer && "lineNr" in previewer && previewer.lineNr) {
        await fn.cursor(denops, [previewer.lineNr, 0]);
        await denops.cmd("normal! zv");
        await denops.cmd("normal! zz");
      }
    });
  }

  private async highlight(denops: Denops, previewer: Previewer, winid: number) {
    if (this.matchIds[winid] > 0) {
      await fn.matchdelete(denops, this.matchIds[winid], winid);
    }
    if (previewer && "lineNr" in previewer && previewer.lineNr) {
      this.matchIds[winid] = await fn.matchaddpos(denops, "Search", [
        previewer.lineNr,
      ]) as number;
    }
  }
}
