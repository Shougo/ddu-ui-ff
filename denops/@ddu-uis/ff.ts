import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v1.2.0/types.ts";
import {
  batch,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v1.2.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.3.0/file.ts";

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

type HighlightGroup = {
  floating?: string;
  prompt?: string;
};

type Params = {
  autoResize: boolean;
  cursorPos: number;
  displaySourceName: "long" | "short" | "no";
  floatingBorder:
    | "none"
    | "single"
    | "double"
    | "rounded"
    | "solid"
    | "shadow"
    | string[];
  filterFloatingPosition: "top" | "bottom";
  filterSplitDirection: "botright" | "topleft" | "floating";
  filterUpdateTime: number;
  highlights: HighlightGroup;
  ignoreEmpty: boolean;
  previewFloating: boolean;
  previewHeight: number;
  previewVertical: boolean;
  previewWidth: number;
  prompt: string;
  reversed: boolean;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
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
  private saveMode = "";
  private checkEnd = false;
  private refreshed = false;
  private prevLength = -1;

  async onInit(args: {
    denops: Denops;
  }): Promise<void> {
    this.saveMode = await fn.mode(args.denops);
    this.checkEnd = await fn.col(args.denops, "$") == await fn.col(args.denops, ".");
  }

  refreshItems(args: {
    items: DduItem[];
  }): void {
    // Note: Use only 1000 items
    this.prevLength = this.items.length;
    this.items = args.items.slice(0, 1000);
    this.selectedItems.clear();
    this.refreshed = true;
  }

  async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    if (args.uiParams.ignoreEmpty && args.context.maxItems == 0) {
      // Disable redraw when empty items
      return;
    }

    const bufferName = `ddu-ff-${args.options.name}`;
    const initialized = this.buffers[args.options.name] ||
      await fn.bufexists(args.denops, bufferName) &&
        await fn.bufnr(args.denops, bufferName);
    const bufnr = initialized || await this.initBuffer(args.denops, bufferName);
    this.buffers[args.options.name] = bufnr;

    await fn.setbufvar(args.denops, bufnr, "&modifiable", 1);

    await this.setDefaultParams(args.denops, args.uiParams);

    const hasNvim = args.denops.meta.host == "nvim";
    const floating = args.uiParams.split == "floating" && hasNvim;
    const ids = await fn.win_findbuf(args.denops, bufnr) as number[];
    const winHeight = args.uiParams.autoResize &&
        this.items.length < Number(args.uiParams.winHeight)
      ? Math.max(this.items.length, 1)
      : Number(args.uiParams.winHeight);
    if (ids.length == 0) {
      const direction = args.uiParams.splitDirection;
      if (args.uiParams.split == "horizontal") {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      } else if (args.uiParams.split == "vertical") {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${args.uiParams.winWidth} ${bufnr}`,
        );
      } else if (floating) {
        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": Number(args.uiParams.winRow),
          "col": Number(args.uiParams.winCol),
          "width": Number(args.uiParams.winWidth),
          "height": winHeight,
          "border": args.uiParams.floatingBorder,
        });

        if (args.uiParams.highlights?.floating) {
          await fn.setwinvar(
            args.denops,
            await fn.bufwinnr(args.denops, bufnr),
            "&winhighlight",
            args.uiParams.highlights.floating,
          );
        }
      } else if (args.uiParams.split == "no") {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await args.denops.call(
          "ddu#util#print_error",
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
    } else if (args.uiParams.autoResize) {
      await fn.win_execute(
        args.denops,
        await fn.bufwinid(args.denops, bufnr),
        `resize ${winHeight}`,
      );
      if (this.filterBufnr > 0) {
        const parentId = await vars.g.get(
          args.denops,
          "ddu#ui#ff#_filter_parent_winid",
          -1,
        );
        // Redraw floating window
        await args.denops.call(
          "ddu#ui#ff#filter#_floating",
          this.filterBufnr,
          parentId,
          args.uiParams,
        );
      }
    }

    if (this.refreshed) {
      await this.initOptions(args.denops, args.options, bufnr);
    }

    const header =
      `[ddu-${args.options.name}] ${this.items.length}/${args.context.maxItems}`;
    const linenr = "printf('%'.(len(line('$'))+2).'d/%d',line('.'),line('$'))";
    const async = `${args.context.done ? "" : "[async]"}`;
    const laststatus = await op.laststatus.get(args.denops);
    if (hasNvim && (floating || laststatus == 0)) {
      if (this.saveTitle == "") {
        this.saveTitle = await args.denops.call(
          "nvim_get_option",
          "titlestring",
        ) as string;
        await vars.g.set(args.denops, "ddu#ui#ff#_save_title", this.saveTitle);
        if (await fn.exists(args.denops, '##WinClosed')) {
          await args.denops.cmd(
            "autocmd WinClosed,BufLeave <buffer> ++once " +
              " let &titlestring=g:ddu#ui#ff#_save_title",
          );
        }
      }

      args.denops.call(
        "nvim_set_option",
        "titlestring",
        header + " %{" + linenr + "}%*" + async,
      );
    } else {
      await fn.setwinvar(
        args.denops,
        await fn.bufwinnr(args.denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*" + async,
      );
    }

    // Update main buffer
    const displaySourceName = args.uiParams.displaySourceName;
    const promptPrefix = args.uiParams.prompt == "" ? "" : " ".repeat(
      1 + (await fn.strwidth(args.denops, args.uiParams.prompt) as number),
    );
    const getSourceName = (sourceName: string) => {
      if (displaySourceName == "long") {
        return sourceName + " ";
      }
      if (displaySourceName == "short") {
        return sourceName.match(/[^a-zA-Z]/)
          ? sourceName.replaceAll(/([a-zA-Z])[a-zA-Z]+/g, "$1") + " "
          : sourceName.slice(0, 2) + " ";
      }
      return "";
    };
    const cursorPos = args.uiParams.cursorPos >= 0
      ? args.uiParams.cursorPos
      : 0;
    await args.denops.call(
      "ddu#ui#ff#_update_buffer",
      args.uiParams,
      bufnr,
      [...this.selectedItems],
      this.items.map((c, i) => {
        return {
          highlights: c.highlights ?? [],
          row: i + 1,
          prefix: promptPrefix + `${getSourceName(c.__sourceName)}`,
        };
      }).filter((c) => c.highlights),
      this.items.map((c) =>
        promptPrefix +
        `${getSourceName(c.__sourceName)}` +
        (c.display ?? c.word)
      ),
      args.uiParams.cursorPos >= 0 || (this.refreshed &&
          (this.prevLength > 0 && this.items.length < this.prevLength) ||
        (args.uiParams.reversed && this.items.length != this.prevLength)),
      cursorPos,
    );

    if (ids.length == 0) {
      if (args.uiParams.startFilter) {
        this.filterBufnr = await args.denops.call(
          "ddu#ui#ff#filter#_open",
          args.options.name,
          args.context.input,
          this.filterBufnr,
          args.uiParams,
        ) as number;
      } else {
        await args.denops.cmd("stopinsert");
      }
    }

    if (
      !args.uiParams.startFilter && args.options.resume &&
      this.saveCursor.length != 0
    ) {
      await fn.cursor(args.denops, this.saveCursor[1], this.saveCursor[2]);
      this.saveCursor = [];
    }

    this.saveCursor = await fn.getcurpos(args.denops) as number[];

    this.refreshed = false;
  }

  async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    const ft = await op.filetype.getLocal(args.denops);
    if (ft == "ddu-ff-filter") {
      // Close filter window and move to the UI window.
      await args.denops.cmd("close!");
      const parentId = await vars.g.get(
        args.denops,
        "ddu#ui#ff#_filter_parent_winid",
        -1,
      );
      await fn.win_gotoid(args.denops, parentId);
    }

    this.saveCursor = await fn.getcurpos(args.denops) as number[];

    if (args.uiParams.split == "no") {
      await args.denops.cmd(`buffer ${args.context.bufNr}`);
      return;
    }

    if ((await fn.winnr(args.denops, "$")) == 1) {
      await args.denops.cmd("enew");
    } else {
      await args.denops.cmd("close!");
      await fn.win_gotoid(args.denops, args.context.winId);
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

    // Restore mode
    if (this.saveMode == "i") {
      if (this.checkEnd) {
        await fn.feedkeys(args.denops, "A", "n");
      } else {
        await args.denops.cmd("startinsert");
      }
    } else {
      await args.denops.cmd("stopinsert");
    }

    // Close preview window
    await args.denops.cmd("pclose!");

    await args.denops.call("ddu#event", args.options.name, "close");
  }

  private async getItems(denops: Denops, uiParams: Params): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.selectedItems.size == 0) {
      const idx = await this.getIndex(denops, uiParams);
      items = [this.items[idx]];
    } else {
      items = [...this.selectedItems].map((i) => this.items[i]);
    }

    return items.filter((item) => item);
  }

  actions: UiActions<Params> = {
    chooseAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const items = await this.getItems(args.denops, args.uiParams);
      if (items.length == 0) {
        return Promise.resolve(ActionFlags.None);
      }

      this.saveCursor = await fn.getcurpos(args.denops) as number[];

      const actions = await args.denops.call(
        "ddu#get_item_actions",
        args.options.name,
        items,
      );

      await args.denops.call("ddu#start", {
        name: args.options.name,
        push: true,
        sources: [
          {
            name: "action",
            options: {},
            params: {
              actions: actions,
              name: args.options.name,
              items: items,
            },
          },
        ],
      });

      return Promise.resolve(ActionFlags.None);
    },
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const params = args.actionParams as DoActionParams;
      const items = params.items ?? await this.getItems(
        args.denops,
        args.uiParams,
      );
      if (items.length == 0) {
        return Promise.resolve(ActionFlags.None);
      }

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
        "ddu#ui#ff#filter#_open",
        args.options.name,
        args.context.input,
        this.filterBufnr,
        args.uiParams,
      ) as number;

      return Promise.resolve(ActionFlags.None);
    },
    preview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const idx = await this.getIndex(args.denops, args.uiParams);
      const item = this.items[idx];
      if (!item) {
        return Promise.resolve(ActionFlags.None);
      }

      const action = item.action as ActionData;
      if (!action.path) {
        return Promise.resolve(ActionFlags.None);
      }

      const prevId = await fn.win_getid(args.denops);

      await args.denops.call(
        "ddu#ui#ff#_preview_file",
        args.uiParams,
        action.path,
      );

      await fn.win_gotoid(args.denops, prevId);

      return Promise.resolve(ActionFlags.Persist);
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.quit({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
      });
      await args.denops.call("ddu#pop", args.options.name);

      return Promise.resolve(ActionFlags.None);
    },
    // deno-lint-ignore require-await
    refreshItems: async (_: {
      denops: Denops;
    }) => {
      return Promise.resolve(ActionFlags.RefreshItems);
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      if (this.items.length == 0) {
        return Promise.resolve(ActionFlags.None);
      }

      const idx = await this.getIndex(args.denops, args.uiParams);
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
      autoResize: false,
      cursorPos: -1,
      displaySourceName: "no",
      floatingBorder: "none",
      filterFloatingPosition: "bottom",
      filterSplitDirection: "botright",
      filterUpdateTime: 0,
      highlights: {},
      ignoreEmpty: false,
      previewFloating: false,
      previewHeight: 10,
      previewVertical: false,
      previewWidth: 40,
      prompt: "",
      reversed: false,
      split: "horizontal",
      splitDirection: "botright",
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

  private async initOptions(
    denops: Denops,
    options: DduOptions,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.bufwinid(denops, bufnr);

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&cursorline", 1);
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");

      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-ff");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);
    });
  }

  private async setDefaultParams(denops: Denops, uiParams: Params) {
    if (uiParams.winRow == 0) {
      uiParams.winRow = Math.trunc(
        (await denops.call("eval", "&lines") as number) / 2 - 10,
      );
    }
    if (uiParams.winCol == 0) {
      uiParams.winCol = Math.trunc(
        (await op.columns.getGlobal(denops)) / 4,
      );
    }
    if (uiParams.winWidth == 0) {
      uiParams.winWidth = Math.trunc((await op.columns.getGlobal(denops)) / 2);
    }
  }

  private async getIndex(
    denops: Denops,
    uiParams: Params,
  ): Promise<number> {
    const ft = await op.filetype.getLocal(denops);
    const parentId = await vars.g.get(
      denops,
      "ddu#ui#ff#_filter_parent_winid",
      -1,
    );
    const idx = ft == "ddu-ff"
      ? (await fn.line(denops, ".")) - 1
      : (await denops.call("line", ".", parentId) as number) - 1;
    return uiParams.reversed ? this.items.length - 1 - idx : idx;
  }
}
