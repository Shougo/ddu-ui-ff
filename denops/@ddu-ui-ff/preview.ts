import {
  ActionFlags,
  BufferPreviewer,
  Context,
  DduItem,
  DduOptions,
  NoFilePreviewer,
  Previewer,
  TermPreviewer,
} from "/home/denjo/.cache/dein/repos/github.com/Shougo/ddu.vim/denops/ddu/types.ts";
import { batch, Denops, fn } from "https://deno.land/x/ddu_vim@v1.5.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.3.0/file.ts";
import { replace } from "https://deno.land/x/denops_std@v3.3.0/buffer/mod.ts";
import { Params } from "../@ddu-uis/ff.ts";

export class PreviewUi {
  private previewWinId = -1;
  private previewBufnr = -1;
  private previewedTarget: ActionData = {};

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
    } else if (previewer.kind == "buffer") {
      flag = await this.previewBuffer(denops, previewer, uiParams);
    } else {
      flag = await this.previewNoFile(denops, previewer, uiParams);
    }
    if (flag == ActionFlags.None) {
      return flag;
    }

    if ("lineNr" in previewer) {
      await this.jump(denops, previewer.lineNr);
    }
    await this.highlight(denops, previewer);

    this.previewWinId = await fn.win_getid(denops) as number;
    this.previewBufnr = await fn.bufnr(denops);
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
      this.previewBufnr > 0 &&
      (await fn.bufexists(denops, this.previewBufnr))
    ) {
      try {
        await denops.cmd(`bdelete! ${this.previewBufnr}`);
        this.previewBufnr = -1;
      } catch (e) {
        console.error(e);
      }
    }
    return ActionFlags.Persist;
  }

  private async previewBuffer(
    denops: Denops,
    previewer: BufferPreviewer,
    uiParams: Params,
  ): Promise<ActionFlags> {
    if (!previewer.expr && !previewer.path) {
      return Promise.resolve(ActionFlags.None);
    }
    const bufname = `ddu-ff:${
      previewer.expr
        ? await fn.bufname(
          denops,
          previewer.expr,
        )
        : previewer.path
    }`;
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
      const data = Deno.readFileSync(previewer.path);
      const text = new TextDecoder().decode(data);
      await batch(denops, async (denops: Denops) => {
        await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
        await fn.setbufvar(denops, bufnr, "&cursorline", 1);
        await replace(denops, bufnr, text.split("\n"));
        await denops.cmd("filetype detect");
      });
    } else {
      await denops.cmd(`buffer ${bufname}`);
    }
    return ActionFlags.Persist;
  }

  private async previewNoFile(
    denops: Denops,
    previewer: NoFilePreviewer,
    uiParams: Params,
  ): Promise<ActionFlags> {
    return ActionFlags.Persist;
  }

  private async jump(denops: Denops, lineNr: number) {
    await batch(denops, async (denops: Denops) => {
      await fn.cursor(denops, [lineNr, 0]);
      await denops.cmd("normal! zv");
      await denops.cmd("normal! zz");
    });
  }

  private async highlight(denops: Denops, previewer: Previewer) {
    // if (previewer && "lineNr" in previewer) {
    //   await fn.matchaddpos(denops, "Search", [previewer.lineNr]);
    // }
  }
}
