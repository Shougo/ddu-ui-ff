import {
  ActionFlags,
  BaseUi,
  DduItem,
  DduOptions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v0.1.0/types.ts";
import { Denops, fn, op } from "https://deno.land/x/ddu_vim@v0.1.0/deps.ts";
import { ActionArguments } from "https://deno.land/x/ddu_vim@v0.1.0/base/ui.ts";

type DoActionParams = {
  name?: string;
  params?: unknown;
};

type Params = {
  split: "horizontal" | "vertical" | "floating" | "no";
  startFilter: boolean;
};

export class Ui extends BaseUi<Params> {
  private bufnr = -1;
  private filterBufnr = -1;
  private items: DduItem[] = [];
  private selectedItems: Set<number> = new Set();

  refreshItems(args: {
    items: DduItem[];
  }): void {
    // Note: Use only 1000 items
    this.items = args.items.slice(0, 1000);
    this.selectedItems.clear();
  }

  async redraw(args: {
    denops: Denops;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    const bufferName = `ddu-std-${args.options.name}`;
    const bufnr = this.bufnr > 0
      ? this.bufnr
      : await this.initBuffer(args.denops, bufferName);

    await fn.setbufvar(args.denops, bufnr, "&modifiable", 1);

    const ids = await fn.win_findbuf(args.denops, bufnr) as number[];
    if (ids.length == 0) {
      if (args.uiParams.split == "horizontal") {
        await args.denops.cmd(`silent keepalt sbuffer ${bufnr}`);
      } else if (args.uiParams.split == "vertical") {
        await args.denops.cmd(`silent keepalt vertical sbuffer ${bufnr}`);
      } else if (args.uiParams.split == "floating") {
        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": Math.ceil(
            (await args.denops.call("eval", "&lines") as number) / 2 - 10,
          ),
          "col": Math.ceil((await op.columns.getGlobal(args.denops)) / 4),
          "width": Math.ceil((await op.columns.getGlobal(args.denops)) / 2),
          "height": 20,
        });
      } else if (
        args.uiParams.split == "no" && await fn.has(args.denops, "nvim")
      ) {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await args.denops.call(
          "ddu#util#print_error",
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
    }

    if (this.bufnr <= 0) {
      // Highlights must be initialized when not exists
      await this.initHighlights(args.denops, bufnr);
    }

    // Update main buffer
    await args.denops.call(
      "ddu#ui#std#update_buffer",
      bufnr,
      this.items.map(
        (c, i) =>
          `${this.selectedItems.has(i) ? "*" : " "}${
            c.display ? c.display : c.word
          }`,
      ),
    );

    await fn.setbufvar(args.denops, bufnr, "ddu_ui_name", args.options.name);

    const filterIds = await fn.win_findbuf(
      args.denops,
      this.filterBufnr,
    ) as number[];
    if (filterIds.length == 0 && args.uiParams.startFilter) {
      this.filterBufnr = await args.denops.call(
        "ddu#ui#std#filter#_open",
        args.options.name,
        args.options.input,
        this.filterBufnr,
        args.uiParams,
      ) as number;
    }

    this.bufnr = bufnr;
  }

  async quit(args: {
    denops: Denops;
    options: DduOptions;
  }): Promise<void> {
    if (this.bufnr <= 0) {
      return;
    }

    const ids = await fn.win_findbuf(args.denops, this.bufnr) as number[];
    if (ids.length == 0) {
      await args.denops.cmd(`buffer ${this.bufnr}`);
      return;
    }

    await fn.win_gotoid(args.denops, ids[0]);
    await args.denops.cmd("close!");
  }

  actions: Record<
    string,
    (args: ActionArguments<Params>) => Promise<ActionFlags>
  > = {
    doAction: async (args: {
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

      const params = args.actionParams as DoActionParams;
      await args.denops.call(
        "ddu#do_action",
        args.options.name,
        params.name ?? "default",
        items,
        params.params ?? {},
      );

      return Promise.resolve(ActionFlags.None);
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const idx = (await fn.line(args.denops, ".")) - 1;
      if (this.selectedItems.has(idx)) {
        this.selectedItems.delete(idx);
      } else {
        this.selectedItems.add(idx);
      }

      return Promise.resolve(ActionFlags.Redraw);
    },
    openFilterWindow: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      this.filterBufnr = await args.denops.call(
        "ddu#ui#std#filter#_open",
        args.options.name,
        args.options.input,
        this.filterBufnr,
        args.uiParams,
      ) as number;

      return Promise.resolve(ActionFlags.None);
    },
    quit: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      await this.quit({ denops: args.denops, options: args.options });
      return Promise.resolve(ActionFlags.None);
    },
  };

  params(): Params {
    return {
      split: "horizontal",
      startFilter: false,
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
    await fn.setwinvar(denops, winid, "&conceallevel", 3);
    await fn.setwinvar(denops, winid, "&concealcursor", "inv");

    // Highlights
    await denops.cmd(
      "highlight default link dduStdSelectedLine Statement",
    );

    await denops.cmd(
      `syntax match dduStdNormalLine /^[ ].*/` +
        " contains=dduStdConcealedMark",
    );
    await denops.cmd(
      `syntax match dduStdSelectedLine /^[*].*/` +
        " contains=dduStdConcealedMark",
    );
    await denops.cmd(
      `syntax match dduStdConcealedMark /^[ *]/` +
        " conceal contained",
    );

    await fn.setbufvar(denops, bufnr, "&filetype", "ddu-std");
  }
}