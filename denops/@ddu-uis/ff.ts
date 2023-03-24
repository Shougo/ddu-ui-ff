import {
  ActionFlags,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v2.5.0/types.ts";
import {
  batch,
  Denops,
  fn,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v2.5.0/deps.ts";
import { PreviewUi } from "../@ddu-ui-ff/preview.ts";

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

type HighlightGroup = {
  floating?: string;
  preview?: string;
  prompt?: string;
  selected?: string;
};

type AutoAction = {
  name?: string;
  params?: unknown;
  delay?: number;
};

type FloatingBorder =
  | "none"
  | "single"
  | "double"
  | "rounded"
  | "solid"
  | "shadow"
  | string[];

type SaveCursor = {
  pos: number[];
  text: string;
};

type ExpandItemParams = {
  mode?: "toggle";
  maxLevel?: number;
};

export type Params = {
  autoAction: AutoAction;
  autoResize: boolean;
  cursorPos: number;
  displaySourceName: "long" | "short" | "no";
  displayTree: boolean;
  filterFloatingPosition: "top" | "bottom";
  filterSplitDirection: "botright" | "topleft" | "floating";
  filterUpdateTime: number;
  floatingBorder: FloatingBorder;
  highlights: HighlightGroup;
  ignoreEmpty: boolean;
  previewCol: number;
  previewFloating: boolean;
  previewFloatingBorder: FloatingBorder;
  previewFloatingZindex: number;
  previewHeight: number;
  previewRow: number;
  previewSplit: "horizontal" | "vertical" | "no";
  previewWidth: number;
  prompt: string;
  replaceCol: number;
  reversed: boolean;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "botright" | "topleft";
  startFilter: boolean;
  statusline: boolean;
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
};

export class Ui extends BaseUi<Params> {
  private buffers: Record<string, number> = {};
  private filterBufnr = -1;
  private items: DduItem[] = [];
  private viewItems: DduItem[] = [];
  private selectedItems: Set<number> = new Set();
  private saveMode = "";
  private saveCmdline = "";
  private saveCmdpos = 0;
  private saveCol = 0;
  private refreshed = false;
  private prevLength = -1;
  private previewUi = new PreviewUi();

  override async onInit(args: {
    denops: Denops;
  }): Promise<void> {
    this.saveMode = await fn.mode(args.denops);
    if (this.saveMode == "c") {
      this.saveMode = await fn.getcmdtype(args.denops) as string;
      if (this.saveMode == ":") {
        // Save command line state
        this.saveCmdline = await fn.getcmdline(args.denops) as string;
        this.saveCmdpos = await fn.getcmdpos(args.denops) as number;
      }
    } else {
      this.saveCol = await fn.col(args.denops, ".") as number;
    }
    this.filterBufnr = -1;
  }

  override async onBeforeAction(args: {
    denops: Denops;
  }): Promise<void> {
    await vars.g.set(args.denops, "ddu#ui#ff#_in_action", true);

    const ft = await op.filetype.getLocal(args.denops);
    const parentId = await vars.g.get(
      args.denops,
      "ddu#ui#ff#_filter_parent_winid",
      -1,
    );
    if (ft == "ddu-ff" || parentId < 0) {
      await vars.b.set(args.denops, "ddu_ui_ff_cursor_pos",
                       await fn.getcurpos(args.denops));
      await vars.b.set(args.denops, "ddu_ui_ff_cursor_text",
                       await fn.getline(args.denops, "."));
    } else {
      await fn.win_execute(args.denops, parentId,
                           "let b:ddu_ui_ff_cursor_pos = getcurpos()");
      await fn.win_execute(args.denops, parentId,
                           "let b:ddu_ui_ff_cursor_text = getline('.')");
    }
  }

  override async onAfterAction(args: {
    denops: Denops;
  }): Promise<void> {
    await vars.g.set(args.denops, "ddu#ui#ff#_in_action", false);
  }

  // deno-lint-ignore require-await
  async refreshItems(args: {
    items: DduItem[];
  }): Promise<void> {
    // NOTE: Use only 1000 items
    this.prevLength = this.items.length;
    this.items = args.items.slice(0, 1000);
    this.selectedItems.clear();
    this.refreshed = true;
  }

  override async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const pos = this.items.findIndex((item) => item == args.item);

    if (pos > 0) {
      await fn.cursor(args.denops, pos + 1, 0);
      await args.denops.cmd("normal! zz");
    }
  }

  override async redraw(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    if (args.options.sync && !args.context.done) {
      // Skip redraw if all items are not done
      return;
    }

    if (this.items.length == 0) {
      // Close preview window when empty items
      await this.previewUi.close(args.denops, args.context);
    }

    if (
      this.prevLength <= 0 && args.uiParams.ignoreEmpty &&
      args.context.maxItems == 0
    ) {
      // Disable redraw when empty items
      return;
    }

    const bufferName = `ddu-ff-${args.options.name}`;
    const initialized = this.buffers[args.options.name] ||
      (await fn.bufexists(args.denops, bufferName) &&
        await fn.bufnr(args.denops, bufferName));
    const bufnr = initialized || await this.initBuffer(args.denops, bufferName);

    await this.setDefaultParams(args.denops, args.uiParams);

    const hasNvim = args.denops.meta.host == "nvim";
    const hasAutoAction = "name" in args.uiParams.autoAction;
    const floating = args.uiParams.split == "floating" && hasNvim;
    const winHeight = args.uiParams.autoResize &&
        this.items.length < Number(args.uiParams.winHeight)
      ? Math.max(this.items.length, 1)
      : Number(args.uiParams.winHeight);
    const winid = await fn.bufwinid(args.denops, bufnr);
    if (winid < 0) {
      const direction = args.uiParams.splitDirection;
      if (args.uiParams.split == "horizontal") {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      } else if (args.uiParams.split == "vertical") {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header +
            `sbuffer +vertical\\ resize\\ ${args.uiParams.winWidth} ${bufnr}`,
        );
      } else if (floating) {
        // statusline must be set for floating window
        const currentStatusline = await op.statusline.get(args.denops);

        await args.denops.call("nvim_open_win", bufnr, true, {
          "relative": "editor",
          "row": Number(args.uiParams.winRow),
          "col": Number(args.uiParams.winCol),
          "width": Number(args.uiParams.winWidth),
          "height": winHeight,
          "border": args.uiParams.floatingBorder,
        });

        await fn.setwinvar(
          args.denops,
          await fn.bufwinnr(args.denops, bufnr),
          "&winhighlight",
          `Normal:${args.uiParams.highlights?.floating ?? "NormalFloat"}`,
        );

        await fn.setwinvar(
          args.denops,
          await fn.bufwinnr(args.denops, bufnr),
          "&statusline",
          currentStatusline,
        );
      } else if (args.uiParams.split == "no") {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      } else {
        await args.denops.call(
          "ddu#util#print_error",
          `Invalid split param: ${args.uiParams.split}`,
        );
        return;
      }
      await batch(args.denops, async (denops: Denops) => {
        await denops.call("ddu#ui#ff#_reset_auto_action");
        if (hasAutoAction) {
          const autoAction = args.uiParams.autoAction;
          if (!("params" in autoAction)) {
            autoAction.params = {};
          }
          if (!("delay" in autoAction)) {
            autoAction.delay = 100;
          }
          await denops.call(
            "ddu#ui#ff#_set_auto_action",
            autoAction,
          );
        }
      });
    } else if (args.uiParams.autoResize) {
      await fn.win_execute(
        args.denops,
        winid,
        `resize ${winHeight} | normal! zb`,
      );
      if ((await fn.bufwinid(args.denops, this.filterBufnr)) >= 0) {
        // Redraw floating window
        await args.denops.call(
          "ddu#ui#ff#filter#_floating",
          this.filterBufnr,
          winid,
          args.uiParams,
        );
      }
    }

    // NOTE: buffers may be restored
    if (!this.buffers[args.options.name] || winid < 0) {
      await this.initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    const augroupName = `${await op.filetype.getLocal(args.denops)}-${bufnr}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

    await this.setStatusline(
      args.denops,
      args.context,
      args.options,
      args.uiParams,
      bufnr,
      hasNvim,
      floating,
      augroupName,
    );

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
    const cursorPos = args.uiParams.cursorPos >= 0 &&
        this.refreshed && args.context.done
      ? args.uiParams.cursorPos
      : 0;
    const refreshed = args.uiParams.cursorPos >= 0 || (this.refreshed &&
        (this.prevLength > 0 && this.items.length < this.prevLength) ||
      (args.uiParams.reversed && this.items.length != this.prevLength));

    const getPrefix = (item: DduItem) => {
      return promptPrefix + `${getSourceName(item.__sourceName)}` +
        (args.uiParams.displayTree
          ? " ".repeat(item.__level) +
            (!item.isTree ? "  " : item.__expanded ? "- " : "+ ")
          : "");
    };

    // Update main buffer
    try {
      // Note: Use batch for screen flicker when highlight items.
      await batch(args.denops, async (denops: Denops) => {
        await denops.call(
          "ddu#ui#ff#_update_buffer",
          args.uiParams,
          bufnr,
          this.items.map((c) => getPrefix(c) + (c.display ?? c.word)),
          refreshed,
          cursorPos,
        );
        await denops.call(
          "ddu#ui#ff#_highlight_items",
          args.uiParams,
          bufnr,
          this.items.length,
          this.items.map((item, index) => {
            return {
              highlights: item.highlights ?? [],
              row: index + 1,
              prefix: getPrefix(item),
            };
          }).filter((item) => item.highlights),
          [...this.selectedItems],
        );
      });
    } catch (e) {
      await errorException(
        args.denops,
        e,
        "[ddu-ui-ff] update buffer failed",
      );
      return;
    }

    this.viewItems = Array.from(this.items);
    if (args.uiParams.reversed) {
      this.viewItems = this.viewItems.reverse();
    }

    // Save cursor when cursor moved
    await args.denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer>` +
        " call ddu#ui#ff#_save_cursor()",
    );

    const saveCursor = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_ff_save_cursor",
      { pos: [], text: "" },
    ) as SaveCursor;
    let currentText = "";
    if (saveCursor.pos.length != 0) {
      const buflines = await fn.getbufline(
        args.denops,
        bufnr,
        saveCursor.pos[1],
      );
      if (buflines.length != 0) {
        currentText = buflines[0];
      }
    }
    if (
      saveCursor.pos.length != 0 && this.items.length != 0 &&
      currentText == saveCursor.text && !this.refreshed &&
      !(args.uiParams.startFilter && hasAutoAction)
    ) {
      // NOTE: startFilter with autoAction breaks cursor
      await args.denops.call(
        "ddu#ui#ff#_cursor",
        saveCursor.pos[1],
        saveCursor.pos[2],
      );
    } else if (hasAutoAction && winid < 0) {
      // Call auto action
      await args.denops.call("ddu#ui#ff#_do_auto_action");
    }

    if (this.filterBufnr < 0 || winid < 0) {
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

    this.buffers[args.options.name] = bufnr;

    this.refreshed = false;
  }

  override async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    await this.closeBuffer({
      denops: args.denops,
      context: args.context,
      options: args.options,
      uiParams: args.uiParams,
      cancel: false,
    });
  }

  // deno-lint-ignore require-await
  override async expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
  }) {
    // Search index.
    const index = this.items.findIndex(
      (item: DduItem) =>
        item.treePath == args.parent.treePath &&
        item.__sourceIndex == args.parent.__sourceIndex,
    );

    const insertItems = args.children;

    if (index >= 0) {
      this.items = this.items.slice(0, index + 1).concat(insertItems).concat(
        this.items.slice(index + 1),
      );
      this.items[index] = args.parent;
    } else {
      this.items = this.items.concat(insertItems);
    }

    this.selectedItems.clear();
  }

  // deno-lint-ignore require-await
  async collapseItem(args: {
    item: DduItem;
  }) {
    // Search index.
    const startIndex = this.items.findIndex(
      (item: DduItem) =>
        item.treePath == args.item.treePath &&
        item.__sourceIndex == args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return;
    }

    const endIndex = this.items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= args.item.__level,
    );

    if (endIndex < 0) {
      this.items = this.items.slice(0, startIndex + 1);
    } else {
      this.items = this.items.slice(0, startIndex + 1).concat(
        this.items.slice(startIndex + endIndex + 1),
      );
    }

    this.items[startIndex] = args.item;

    this.selectedItems.clear();
  }

  override actions: UiActions<Params> = {
    checkItems: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      await args.denops.call("ddu#redraw", args.options.name, {
        check: true,
        refreshItems: true,
      });

      return ActionFlags.None;
    },
    chooseAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.closeFilterWindow(args.denops);

      const items = await this.getItems(args.denops);

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

      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    clearSelectAllItems: async (_: {
      denops: Denops;
    }) => {
      this.selectedItems.clear();
      return ActionFlags.Redraw;
    },
    closeFilterWindow: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.closeFilterWindow(args.denops);

      await this.moveParentWindow(args.denops);

      return ActionFlags.None;
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode == "toggle") {
          return await this.collapseItemAction(args.denops, args.options);
        }
        return ActionFlags.None;
      }

      await args.denops.call(
        "ddu#redraw_tree",
        args.options.name,
        "expand",
        [{ item, maxLevel: params.maxLevel ?? 0 }],
      );

      return ActionFlags.None;
    },
    getItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      const bufnr = this.buffers[args.options.name];
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_item", item);

      const ft = await op.filetype.getLocal(args.denops);
      if (ft == "ddu-ff-filter") {
        // Set for filter window
        await vars.b.set(args.denops, "ddu_ui_item", item)
      }

      return ActionFlags.None;
    },
    itemAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const params = args.actionParams as DoActionParams;
      const items = params.items ?? await this.getItems(args.denops);

      await args.denops.call(
        "ddu#item_action",
        args.options.name,
        params.name ?? "default",
        items,
        params.params ?? {},
      );

      return ActionFlags.None;
    },
    leaveFilterWindow: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.moveParentWindow(args.denops);
      return ActionFlags.None;
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

      return ActionFlags.None;
    },
    preview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      if (!item) {
        return ActionFlags.None;
      }

      return this.previewUi.previewContents(
        args.denops,
        args.context,
        args.options,
        args.uiParams,
        args.actionParams,
        this.buffers[args.options.name],
        item,
      );
    },
    previewPath: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      const item = this.items[idx];
      if (!item) {
        return ActionFlags.None;
      }

      await args.denops.call("ddu#ui#ff#_echo", item.display ?? item.word);

      return ActionFlags.Persist;
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
    }) => {
      await this.closeBuffer({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
        cancel: true,
      });
      await args.denops.call("ddu#pop", args.options.name);

      return ActionFlags.None;
    },
    // deno-lint-ignore require-await
    refreshItems: async (_: {
      denops: Denops;
    }) => {
      return ActionFlags.RefreshItems;
    },
    // deno-lint-ignore require-await
    toggleAllItems: async (_: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      if (this.items.length == 0) {
        return ActionFlags.None;
      }

      this.items.forEach((_, idx) => {
        if (this.selectedItems.has(idx)) {
          this.selectedItems.delete(idx);
        } else {
          this.selectedItems.add(idx);
        }
      });

      return ActionFlags.Redraw;
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const idx = await this.getIndex(args.denops);
      if (idx < 0) {
        return ActionFlags.None;
      }

      if (this.selectedItems.has(idx)) {
        this.selectedItems.delete(idx);
      } else {
        this.selectedItems.add(idx);
      }

      return ActionFlags.Redraw;
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      await args.denops.call("ddu#redraw", args.options.name, {
        updateOptions: args.actionParams,
      });
      return ActionFlags.None;
    },
  };

  override params(): Params {
    return {
      autoAction: {},
      autoResize: false,
      cursorPos: -1,
      displaySourceName: "no",
      displayTree: false,
      filterFloatingPosition: "bottom",
      filterSplitDirection: "botright",
      filterUpdateTime: 0,
      floatingBorder: "none",
      highlights: {},
      ignoreEmpty: false,
      previewCol: 0,
      previewFloating: false,
      previewFloatingBorder: "none",
      previewFloatingZindex: 50,
      previewHeight: 10,
      previewRow: 0,
      previewSplit: "horizontal",
      previewWidth: 40,
      prompt: "",
      reversed: false,
      replaceCol: 0,
      split: "horizontal",
      splitDirection: "botright",
      startFilter: false,
      statusline: true,
      winCol: 0,
      winHeight: 20,
      winRow: 0,
      winWidth: 0,
    };
  }

  private async closeBuffer(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    cancel: boolean;
  }): Promise<void> {
    await this.previewUi.close(args.denops, args.context);
    await this.closeFilterWindow(args.denops);
    await args.denops.call("ddu#ui#ff#_reset_auto_action");

    // Move to the UI window.
    const bufnr = this.buffers[args.options.name];
    if (!bufnr) {
      return;
    }
    for (
      const winid of (await fn.win_findbuf(args.denops, bufnr) as number[])
    ) {
      if (winid <= 0) {
        continue;
      }

      await fn.win_gotoid(args.denops, winid);
      await this.closeFilterWindow(args.denops);

      if (
        args.uiParams.split == "no" || (await fn.winnr(args.denops, "$")) == 1
      ) {
        await args.denops.cmd(
          args.context.bufName == "" ? "enew" : `buffer ${args.context.bufNr}`,
        );
      } else {
        await args.denops.cmd("close!");
        await fn.win_gotoid(args.denops, args.context.winId);
      }
    }

    // Restore options
    const saveTitle = await vars.g.get(
      args.denops,
      "ddu#ui#ff#_save_title",
      "",
    );
    if (saveTitle != "") {
      args.denops.call(
        "nvim_set_option",
        "titlestring",
        saveTitle,
      );
    }

    // Restore mode
    if (this.saveMode == "i") {
      if (!args.cancel && args.uiParams.replaceCol > 0) {
        const currentLine = await fn.getline(args.denops, ".");
        const replaceLine = currentLine.slice(
          0,
          args.uiParams.replaceCol - 1,
        ) + currentLine.slice(this.saveCol - 1);
        await fn.setline(args.denops, ".", replaceLine);
        await fn.cursor(args.denops, 0, args.uiParams.replaceCol - 1);
      }

      await fn.feedkeys(
        args.denops,
        args.cancel || args.uiParams.replaceCol > 1 ? "a" : "I",
        "n",
      );
    } else if (this.saveMode == ":") {
      const cmdline = (!args.cancel && args.uiParams.replaceCol > 0)
        ? this.saveCmdline.slice(0, args.uiParams.replaceCol - 1) +
          this.saveCmdline.slice(this.saveCmdpos - 1)
        : this.saveCmdline;
      const cmdpos = (!args.cancel && args.uiParams.replaceCol > 0)
        ? args.uiParams.replaceCol
        : this.saveCmdpos;

      await args.denops.call(
        "ddu#ui#ff#_restore_cmdline",
        cmdline,
        cmdpos,
      );
    } else {
      await args.denops.cmd("stopinsert");
    }

    await args.denops.call("ddu#event", args.options.name, "close");
  }

  private async getItem(
    denops: Denops,
  ): Promise<DduItem | null> {
    const idx = await this.getIndex(denops);
    return idx >= 0 ? this.items[idx] : null;
  }

  private async getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.selectedItems.size == 0) {
      const item = await this.getItem(denops);
      if (!item) {
        return [];
      }

      items = [item];
    } else {
      items = [...this.selectedItems].map((i) => this.items[i]);
    }

    return items.filter((item) => item);
  }

  private async setStatusline(
    denops: Denops,
    context: Context,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
    hasNvim: boolean,
    floating: boolean,
    augroupName: string,
  ): Promise<void> {
    const statusState = {
      done: context.done,
      input: context.input,
      name: options.name,
      maxItems: context.maxItems,
    };
    await fn.setwinvar(
      denops,
      await fn.bufwinnr(denops, bufnr),
      "ddu_ui_ff_status",
      statusState,
    );

    if (!uiParams.statusline) {
      return;
    }

    const header =
      `[ddu-${options.name}] ${this.items.length}/${context.maxItems}`;
    const linenr = "printf('%'.(len(line('$'))+2).'d/%d',line('.'),line('$'))";
    const async = `${context.done ? "" : "[async]"}`;
    const laststatus = await op.laststatus.get(denops);

    if (hasNvim && (floating || laststatus == 0)) {
      if ((await vars.g.get(denops, "ddu#ui#ff#_save_title", "")) == "") {
        const saveTitle = await denops.call(
          "nvim_get_option",
          "titlestring",
        ) as string;
        await vars.g.set(denops, "ddu#ui#ff#_save_title", saveTitle);
      }

      if (await fn.exists(denops, "##WinClosed")) {
        await denops.cmd(
          `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
            " let &titlestring=g:ddu#ui#ff#_save_title",
        );
      }

      const titleString = `${header} %{${linenr}}%*${async}`;
      await vars.b.set(denops, "ddu_ui_ff_title", titleString);

      await denops.call(
        "nvim_set_option",
        "titlestring",
        titleString,
      );
      await denops.cmd(
        `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
          " let &titlestring = " +
          "getbufvar(str2nr(expand('<abuf>')), 'ddu_ui_ff_title')",
      );
    } else {
      await fn.setwinvar(
        denops,
        await fn.bufwinnr(denops, bufnr),
        "&statusline",
        header + " %#LineNR#%{" + linenr + "}%*" + async,
      );
    }
  }

  private async closeFilterWindow(denops: Denops): Promise<void> {
    if (this.filterBufnr > 0) {
      const filterWinNr = await fn.bufwinnr(denops, this.filterBufnr);
      if (filterWinNr > 0) {
        await denops.cmd(`silent! close! ${filterWinNr}`);
      }
    }
  }

  private async moveParentWindow(
    denops: Denops,
  ): Promise<void> {
    const parentId = await vars.g.get(
      denops,
      "ddu#ui#ff#_filter_parent_winid",
      -1,
    );
    if (parentId > 0) {
      await fn.win_gotoid(denops, parentId);
    }
  }

  private async collapseItemAction(denops: Denops, options: DduOptions) {
    const index = await this.getIndex(denops);
    if (index < 0) {
      return ActionFlags.None;
    }

    const closeItem = this.items[index];

    if (!closeItem.isTree) {
      return ActionFlags.None;
    }

    await denops.call(
      "ddu#redraw_tree",
      options.name,
      "collapse",
      [{ item: closeItem }],
    );

    return ActionFlags.None;
  }
  private async initBuffer(
    denops: Denops,
    bufferName: string,
  ): Promise<number> {
    const bufnr = await fn.bufadd(denops, bufferName);
    await fn.bufload(denops, bufnr);

    return bufnr;
  }

  private async initOptions(
    denops: Denops,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
  ): Promise<void> {
    const winid = await fn.bufwinid(denops, bufnr);

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);

      await fn.setbufvar(denops, bufnr, "&bufhidden", "unload");
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-ff");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);

      if (uiParams.split == "horizontal") {
        await fn.setbufvar(denops, bufnr, "&winfixheight", 1);
      } else if (uiParams.split == "vertical") {
        await fn.setbufvar(denops, bufnr, "&winfixwidth", 1);
      }
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
    const viewItem = this.viewItems[idx];
    return this.items.findIndex(
      (item: DduItem) => item == viewItem,
    );
  }
}

async function errorException(denops: Denops, e: unknown, message: string) {
  await denops.call(
    "ddu#util#print_error",
    message,
  );
  if (e instanceof Error) {
    await denops.call(
      "ddu#util#print_error",
      e.message,
    );
    if (e.stack) {
      await denops.call(
        "ddu#util#print_error",
        e.stack,
      );
    }
  }
}
