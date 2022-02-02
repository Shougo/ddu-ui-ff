import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v0.5.0/types.ts";
import {
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v0.5.0/deps.ts";
import { ActionArguments } from "https://deno.land/x/ddu_vim@v0.5.0/base/ui.ts";

type DoActionParams = {
  name?: string;
  params?: unknown;
};

type Params = {
  displaySourceName: "long" | "no";
  filterFloatingPosition: "top" | "bottom";
  filterFloatingPromptPrefix: string;
  filterSplitDirection: "botright" | "floating";
  split: "horizontal" | "vertical" | "floating" | "no";
  startFilter: boolean;
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
};

export class Ui extends BaseUi<Params> {
  private buffers: Record<string, number> = {};
  private filterBufnr = -1;
  private items: DduItem[] = [];
  private selectedItems: Set<number> = new Set();
  private saveTitle = "";
  private saveCursor: number[] = [];

  refreshItems(args: {
    items: DduItem[];
  }): void {
    // Note: Use only 1000 items
    this.items = args.items.slice(0, 1000);
    this.selectedItems.clear();
  }

  async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    const bufferName = `ddu-std-${args.options.name}`;
    const initialized = this.buffers[args.options.name];
    const bufnr = initialized
      ? this.buffers[args.options.name]
      : await this.initBuffer(args.denops, bufferName);

    await fn.setbufvar(args.denops, bufnr, "&modifiable", 1);

    await this.setDefaultParams(args.denops, args.uiParams);

    const floating = args.uiParams.split == "floating" &&
      await fn.has(args.denops, "nvim");
    const ids = await fn.win_findbuf(args.denops, bufnr) as number[];
    if (ids.length == 0) {
      if (args.uiParams.split == "horizontal") {
        const header = "silent keepalt ";
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${args.uiParams.winHeight} ${bufnr}`,
        );
      } else if (args.uiParams.split == "vertical") {
        const header = "silent keepalt vertical ";
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${args.uiParams.winWidth} ${bufnr}`,
        );
      } else if (floating) {
        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": args.uiParams.winRow,
          "col": args.uiParams.winCol,
          "width": args.uiParams.winWidth,
          "height": args.uiParams.winHeight,
        });
      } else if (args.uiParams.split == "no") {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await args.denops.call(
          "ddu#util#print_error",
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
    }

    if (!initialized) {
      // Highlights must be initialized when not exists
      await this.initHighlights(args.denops, bufnr);
    }

    const header = `${args.context.done ? "" : "[async]"}` +
      `[ddu-${args.options.name}] ${this.items.length}/${args.context.maxItems}`;
    const linenr = "printf('%'.(len(line('$'))+2).'d/%d',line('.'),line('$'))";
    if (floating) {
      if (this.saveTitle == "") {
        this.saveTitle = await args.denops.call(
          "nvim_get_option",
          "titlestring",
        ) as string;
      }

      args.denops.call(
        "nvim_set_option",
        "titlestring",
        header + " %{" + linenr + "}%*",
      );
    } else {
      await fn.setwinvar(
        args.denops,
        await fn.bufwinnr(args.denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*",
      );
    }

    // Update main buffer
    const displaySourceName = args.uiParams.displaySourceName;
    await args.denops.call(
      "ddu#ui#std#_update_buffer",
      bufnr,
      [...this.selectedItems],
      this.items.map((c, i) => {
        return {
          highlights: c.highlights,
          row: i + 1,
        };
      }).filter((c) => c.highlights),
      this.items.map((c) =>
          `${displaySourceName == "long" ? c.__sourceName + " " : ""}` +
          (c.display ? c.display : c.word),
      ),
    );

    if (args.options.resume && this.saveCursor.length != 0) {
      await fn.cursor(args.denops, this.saveCursor[1], this.saveCursor[2]);
      this.saveCursor = [];
    }

    await fn.setbufvar(args.denops, bufnr, "ddu_ui_name", args.options.name);
    await vars.g.set(args.denops, "ddu#ui#std#_name", args.options.name);

    if (ids.length == 0 && args.uiParams.startFilter) {
      this.filterBufnr = await args.denops.call(
        "ddu#ui#std#filter#_open",
        args.options.name,
        args.context.input,
        this.filterBufnr,
        args.uiParams,
      ) as number;
    }

    this.buffers[args.options.name] = bufnr;
  }

  async quit(args: {
    denops: Denops;
    options: DduOptions;
  }): Promise<void> {
    const bufnr = this.buffers[args.options.name];

    if (!bufnr) {
      return;
    }

    // Save the cursor
    this.saveCursor = await fn.getcurpos(args.denops) as number[];

    const ids = await fn.win_findbuf(args.denops, bufnr) as number[];
    if (ids.length == 0) {
      await args.denops.cmd(`buffer ${bufnr}`);
      return;
    }

    await fn.win_gotoid(args.denops, ids[0]);
    if ((await fn.winnr(args.denops, "$")) == 1) {
      await args.denops.cmd("enew");
    } else {
      await args.denops.cmd("close!");
    }

    // Restore options
    if (this.saveTitle != "") {
      args.denops.call(
        "nvim_set_option",
        "titlestring",
        this.saveTitle,
      );

      this.saveTitle = "";
    }
  }

  actions: Record<
    string,
    (args: ActionArguments<Params>) => Promise<ActionFlags>
  > = {
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      let items: DduItem[];
      if (this.selectedItems.size == 0) {
        const idx = (await fn.line(args.denops, ".")) - 1;
        items = [this.items[idx]];
      } else {
        items = [...this.selectedItems].map((i) => this.items[i]);
      }

      items = items.filter((item) => item);

      if (items.length == 0) {
        return Promise.resolve(ActionFlags.None);
      }

      const params = args.actionParams as DoActionParams;
      await args.denops.call(
        "ddu#item_action",
        args.options.name,
        params.name ?? "default",
        items,
        params.params ?? {},
      );

      return Promise.resolve(ActionFlags.None);
    },
    openFilterWindow: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.setDefaultParams(args.denops, args.uiParams);

      this.filterBufnr = await args.denops.call(
        "ddu#ui#std#filter#_open",
        args.options.name,
        args.context.input,
        this.filterBufnr,
        args.uiParams,
      ) as number;

      return Promise.resolve(ActionFlags.None);
    },
    // deno-lint-ignore require-await
    refreshItems: async (_: {
      denops: Denops;
    }) => {
      return Promise.resolve(ActionFlags.RefreshItems);
    },
    quit: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      await this.quit({ denops: args.denops, options: args.options });
      return Promise.resolve(ActionFlags.None);
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      if (this.items.length == 0) {
        return Promise.resolve(ActionFlags.None);
      }

      const idx = (await fn.line(args.denops, ".")) - 1;
      if (this.selectedItems.has(idx)) {
        this.selectedItems.delete(idx);
      } else {
        this.selectedItems.add(idx);
      }

      return Promise.resolve(ActionFlags.Redraw);
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      await args.denops.call("ddu#redraw", args.options.name, {
        updateOptions: args.actionParams,
      });
      return Promise.resolve(ActionFlags.None);
    },
  };

  params(): Params {
    return {
      displaySourceName: "no",
      filterFloatingPosition: "bottom",
      filterFloatingPromptPrefix: ">",
      filterSplitDirection: "botright",
      split: "horizontal",
      startFilter: false,
      winCol: 0,
      winHeight: 20,
      winRow: 0,
      winWidth: 0,
    };
  }

  private async initBuffer(
    denops: Denops,
    bufferName: string,
  ): Promise<number> {
    const bufnr = await fn.bufadd(denops, bufferName);
    await fn.bufload(denops, bufnr);

    return Promise.resolve(bufnr);
  }

  private async initHighlights(
    denops: Denops,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.win_getid(denops);

    // Set options
    await fn.setwinvar(denops, winid, "&list", 0);
    await fn.setwinvar(denops, winid, "&colorcolumn", "");
    await fn.setwinvar(denops, winid, "&foldcolumn", 0);
    await fn.setwinvar(denops, winid, "&foldenable", 0);
    await fn.setwinvar(denops, winid, "&number", 0);
    await fn.setwinvar(denops, winid, "&relativenumber", 0);
    await fn.setwinvar(denops, winid, "&spell", 0);
    await fn.setwinvar(denops, winid, "&wrap", 0);

    await fn.setbufvar(denops, bufnr, "&filetype", "ddu-std");
    await fn.setbufvar(denops, bufnr, "&swapfile", 0);
  }

  private async setDefaultParams(denops: Denops, uiParams: Params) {
    if (uiParams.winRow == 0) {
      uiParams.winRow = Math.ceil(
        (await denops.call("eval", "&lines") as number) / 2 - 10,
      );
    }
    if (uiParams.winCol == 0) {
      uiParams.winCol = Math.ceil(
        (await op.columns.getGlobal(denops)) / 4,
      );
    }
    if (uiParams.winWidth == 0) {
      uiParams.winWidth = Math.ceil((await op.columns.getGlobal(denops)) / 2);
    }
  }
}
