import {
  ActionFlags,
  BaseActionParams,
  BaseUi,
  Context,
  DduItem,
  DduOptions,
  PreviewContext,
  Previewer,
  UiActions,
  UiOptions,
} from "https://deno.land/x/ddu_vim@v3.5.0/types.ts";
import {
  batch,
  Denops,
  fn,
  is,
  op,
  vars,
} from "https://deno.land/x/ddu_vim@v3.5.0/deps.ts";
import { PreviewUi } from "./ff/preview.ts";

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

type CursorActionParams = {
  count?: number;
  loop?: boolean;
};

type HighlightGroup = {
  filterText?: string;
  floating?: string;
  floatingBorder?: string;
  floatingCursorLine?: string;
  preview?: string;
  prompt?: string;
  selected?: string;
};

type AutoAction = {
  name?: string;
  params?: unknown;
  delay?: number;
  sync?: boolean;
};

type FloatingOpts = {
  relative: "editor" | "win" | "cursor" | "mouse";
  row: number;
  col: number;
  width: number;
  height: number;
  border?: FloatingBorder;
  title?: FloatingTitle;
  title_pos?: "left" | "center" | "right";
};

type FloatingBorder =
  | "none"
  | "single"
  | "double"
  | "rounded"
  | "solid"
  | "shadow"
  | string[];

type FloatingTitleHighlight = string;

type FloatingTitle =
  | string
  | [string, FloatingTitleHighlight][];

type WindowOption = [string, number | string];

type ExprNumber = string | number;

type SaveCursor = {
  pos: number[];
  text: string;
};

type ExpandItemParams = {
  mode?: "toggle";
  maxLevel?: number;
};

type OnPreviewArguments = {
  denops: Denops;
  context: Context;
  item: DduItem;
  previewWinId: number;
};

type PreviewExecuteParams = {
  command: string;
};

export type Params = {
  autoAction: AutoAction;
  autoResize: boolean;
  cursorPos: number;
  displaySourceName: "long" | "short" | "no";
  displayTree: boolean;
  exprParams: (keyof Params)[];
  filterFloatingPosition: "top" | "bottom";
  filterFloatingTitle: FloatingTitle;
  filterFloatingTitlePos: "left" | "center" | "right";
  filterSplitDirection: "belowright" | "aboveleft" | "floating";
  filterUpdateTime: number;
  floatingBorder: FloatingBorder;
  floatingTitle: FloatingTitle;
  floatingTitlePos: "left" | "center" | "right";
  highlights: HighlightGroup;
  ignoreEmpty: boolean;
  immediateAction: string;
  maxDisplayItems: number;
  maxHighlightItems: number;
  onPreview: string | ((args: OnPreviewArguments) => Promise<void>);
  previewCol: ExprNumber;
  previewFloating: boolean;
  previewFloatingBorder: FloatingBorder;
  previewFloatingTitle: FloatingTitle;
  previewFloatingTitlePos: "left" | "center" | "right";
  previewFloatingZindex: number;
  previewHeight: ExprNumber;
  previewRow: ExprNumber;
  previewSplit: "horizontal" | "vertical" | "no";
  previewWidth: ExprNumber;
  previewWindowOptions: WindowOption[];
  prompt: string;
  replaceCol: number;
  reversed: boolean;
  split: "horizontal" | "vertical" | "floating" | "no";
  splitDirection: "belowright" | "aboveleft" | "topleft" | "botright";
  startAutoAction: boolean;
  startFilter: boolean;
  statusline: boolean;
  winCol: ExprNumber;
  winHeight: ExprNumber;
  winRow: ExprNumber;
  winWidth: ExprNumber;
};

export class Ui extends BaseUi<Params> {
  private bufferName = "";
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
  private prevInput = "";
  private previewUi = new PreviewUi();
  private popupId = -1;
  private enabledAutoAction = false;

  override async onInit(args: {
    denops: Denops;
    uiParams: Params;
  }): Promise<void> {
    this.saveMode = await fn.mode(args.denops);
    if (await op.filetype.getLocal(args.denops) === "ddu-ff-filter") {
      // NOTE: saveMode is ignored in filter window
      this.saveMode = "n";
    }
    if (this.saveMode === "c") {
      this.saveMode = await fn.getcmdtype(args.denops) as string;
      if (this.saveMode === ":") {
        // Save command line state
        this.saveCmdline = await fn.getcmdline(args.denops) as string;
        this.saveCmdpos = await fn.getcmdpos(args.denops) as number;
      }
    } else {
      this.saveCol = await fn.col(args.denops, ".") as number;
    }
    this.filterBufnr = -1;
    this.items = [];
    this.enabledAutoAction = args.uiParams.startAutoAction;
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
    if (ft === "ddu-ff" || parentId < 0) {
      await vars.b.set(
        args.denops,
        "ddu_ui_ff_cursor_pos",
        await fn.getcurpos(args.denops),
      );
      await vars.b.set(
        args.denops,
        "ddu_ui_ff_cursor_text",
        await fn.getline(args.denops, "."),
      );
    } else {
      await fn.win_execute(
        args.denops,
        parentId,
        "let b:ddu_ui_ff_cursor_pos = getcurpos()",
      );
      await fn.win_execute(
        args.denops,
        parentId,
        "let b:ddu_ui_ff_cursor_text = getline('.')",
      );
    }
  }

  override async onAfterAction(args: {
    denops: Denops;
  }): Promise<void> {
    await vars.g.set(args.denops, "ddu#ui#ff#_in_action", false);
  }

  override async refreshItems(args: {
    denops: Denops;
    context: Context;
    uiParams: Params;
    items: DduItem[];
  }): Promise<void> {
    this.prevLength = this.items.length;
    this.prevInput = args.context.input;
    this.items = args.items.slice(0, args.uiParams.maxDisplayItems);
    this.selectedItems.clear();
    this.refreshed = true;

    // Clear saved cursor
    const bufnr = await fn.bufnr(args.denops, this.bufferName);
    if (bufnr > 0) {
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_ff_save_cursor", {
        pos: [],
        text: "",
      });
    }

    return Promise.resolve();
  }

  override async searchItem(args: {
    denops: Denops;
    item: DduItem;
  }) {
    const pos = this.items.findIndex((item) => item === args.item);

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

    if (this.items.length === 0 && args.context.done) {
      // Close preview window when empty items
      await this.previewUi.close(args.denops, args.context, args.uiParams);
    }

    this.bufferName = `ddu-ff-${args.options.name}`;

    const existsUI = await fn.bufwinid(
      args.denops,
      await fn.bufnr(args.denops, this.bufferName),
    ) > 0;

    if (!existsUI) {
      if (args.uiParams.ignoreEmpty && this.items.length === 0) {
        // Disable open UI window when empty items
        return;
      }

      if (
        args.uiParams.immediateAction.length != 0 &&
        this.items.length === 1
      ) {
        // Immediate action
        await args.denops.call(
          "ddu#item_action",
          args.options.name,
          args.uiParams.immediateAction,
          this.items,
          {},
        );
        return;
      }
    }

    const initialized = await fn.bufexists(args.denops, this.bufferName) &&
      await fn.bufnr(args.denops, this.bufferName);

    const bufnr = initialized ||
      await this.initBuffer(args.denops, this.bufferName);

    args.uiParams = await this.resolveParams(
      args.denops,
      args.options,
      args.uiParams,
      args.context,
    );

    const floating = args.uiParams.split === "floating";
    const hasNvim = args.denops.meta.host === "nvim";
    const winWidth = Number(args.uiParams.winWidth);
    let winHeight = args.uiParams.autoResize &&
        this.items.length < Number(args.uiParams.winHeight)
      ? Math.max(this.items.length, 1)
      : Number(args.uiParams.winHeight);
    const winid = (floating && !hasNvim)
      ? this.popupId
      : await fn.bufwinid(args.denops, bufnr);

    const direction = args.uiParams.splitDirection;
    if (args.uiParams.split === "horizontal") {
      // NOTE: If winHeight is bigger than `&lines / 2`, it will be resized.
      const maxWinHeight = Math.floor(
        await op.lines.getGlobal(args.denops) * 4 / 10,
      );
      if (winHeight > maxWinHeight) {
        winHeight = maxWinHeight;
      }

      if (winid >= 0) {
        await fn.win_execute(
          args.denops,
          winid,
          `resize ${winHeight}`,
        );
      } else {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      }
    } else if (args.uiParams.split === "vertical") {
      if (winid >= 0) {
        await fn.win_execute(
          args.denops,
          winid,
          `vertical resize ${winWidth}`,
        );
      } else {
        const header = `silent keepalt vertical ${direction} `;
        await args.denops.cmd(
          header +
            `sbuffer +vertical\\ resize\\ ${winWidth} ${bufnr}`,
        );
      }
    } else if (floating) {
      // statusline must be set for floating window
      const currentStatusline = await op.statusline.get(args.denops);
      const floatingHighlight = args.uiParams.highlights?.floating ??
        "NormalFloat";
      const borderHighlight = args.uiParams.highlights?.floatingBorder ??
        "FloatBorder";
      const cursorLineHighlight =
        args.uiParams.highlights?.floatingCursorLine ?? "CursorLine";

      if (hasNvim) {
        const winOpts: FloatingOpts = {
          "relative": "editor",
          "row": Number(args.uiParams.winRow),
          "col": Number(args.uiParams.winCol),
          "width": winWidth,
          "height": winHeight,
          "border": args.uiParams.floatingBorder,
          "title": args.uiParams.floatingTitle,
          "title_pos": args.uiParams.floatingTitlePos,
        };
        if (!await fn.has(args.denops, "nvim-0.9.0")) {
          // NOTE: "title" and "title_pos" needs neovim 0.9.0+
          delete winOpts.title;
          delete winOpts.title_pos;
        }
        if (winid >= 0) {
          await args.denops.call(
            "nvim_win_set_config",
            this.popupId,
            winOpts,
          );
        } else {
          this.popupId = await args.denops.call(
            "nvim_open_win",
            bufnr,
            true,
            winOpts,
          ) as number;
        }
      } else {
        const winOpts = {
          "pos": "topleft",
          "line": Number(args.uiParams.winRow) + 1,
          "col": Number(args.uiParams.winCol) + 1,
          "highlight": floatingHighlight,
          "border": [],
          "borderchars": [],
          "borderhighlight": [borderHighlight],
          "minwidth": Number(args.uiParams.winWidth),
          "maxwidth": Number(args.uiParams.winWidth),
          "minheight": winHeight,
          "maxheight": winHeight,
          "scrollbar": 0,
          "title": args.uiParams.floatingTitle,
          "wrap": 0,
        } as Record<string, unknown>;

        switch (args.uiParams.floatingBorder) {
          case "none":
            break;
          case "single":
          case "rounded":
          case "solid":
          case "shadow":
            winOpts["border"] = [1, 1, 1, 1];
            break;
          case "double":
            winOpts["border"] = [2, 2, 2, 2];
            break;
          default:
            winOpts["borderchars"] = args.uiParams.floatingBorder;
        }
        if (winid >= 0) {
          await args.denops.call(
            "popup_move",
            this.popupId,
            winOpts,
          );
        } else {
          this.popupId = await args.denops.call(
            "popup_create",
            bufnr,
            winOpts,
          ) as number;
        }
      }

      if (hasNvim) {
        await fn.setwinvar(
          args.denops,
          this.popupId,
          "&winhighlight",
          `Normal:${floatingHighlight},FloatBorder:${borderHighlight},` +
            `CursorLine:${cursorLineHighlight}`,
        );

        await fn.setwinvar(
          args.denops,
          this.popupId,
          "&statusline",
          currentStatusline,
        );
      } else {
        await fn.setwinvar(
          args.denops,
          this.popupId,
          "&cursorline",
          true,
        );

        if (cursorLineHighlight !== "CursorLine") {
          await fn.win_execute(
            args.denops,
            this.popupId,
            `highlight! link CursorLine ${cursorLineHighlight}`,
          );
        }
      }
    } else if (args.uiParams.split === "no") {
      if (winid < 0) {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      }
    } else {
      await args.denops.call(
        "ddu#util#print_error",
        `Invalid split param: ${args.uiParams.split}`,
      );
      return;
    }

    await this.setAutoAction(args.denops, args.uiParams, winid);

    if (args.uiParams.autoResize) {
      await fn.win_execute(
        args.denops,
        winid,
        `resize ${winHeight} | normal! zb`,
      );
      if (await fn.bufwinid(args.denops, this.filterBufnr) >= 0) {
        // Redraw floating window
        await args.denops.call(
          "ddu#ui#ff#filter#_floating",
          this.filterBufnr,
          winid,
          args.uiParams,
        );
      }
    }

    if (!initialized || winid < 0) {
      await this.initOptions(args.denops, args.options, args.uiParams, bufnr);
    }

    const augroupName = `ddu-ui-ff-${bufnr}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

    await this.setStatusline(
      args.denops,
      args.context,
      args.options,
      args.uiParams,
      bufnr,
      floating,
      augroupName,
    );

    // Update main buffer
    const displaySourceName = args.uiParams.displaySourceName;
    const getSourceName = (sourceName: string) => {
      if (displaySourceName === "long") {
        return sourceName + " ";
      }
      if (displaySourceName === "short") {
        return sourceName.match(/[^a-zA-Z]/)
          ? sourceName.replaceAll(/([a-zA-Z])[a-zA-Z]+/g, "$1") + " "
          : sourceName.slice(0, 2) + " ";
      }
      return "";
    };
    const cursorPos = args.uiParams.cursorPos >= 0 && this.refreshed
      ? args.uiParams.cursorPos
      : 0;

    const getPrefix = (item: DduItem) => {
      return `${getSourceName(item.__sourceName)}` +
        (args.uiParams.displayTree
          ? " ".repeat(item.__level) +
            (!item.isTree ? "  " : item.__expanded ? "- " : "+ ")
          : "");
    };

    // Update main buffer
    try {
      const checkRefreshed = args.context.input !== this.prevInput ||
        (this.prevLength > 0 && this.items.length < this.prevLength) ||
        (args.uiParams.reversed && this.items.length !== this.prevLength);
      // NOTE: Use batch for screen flicker when highlight items.
      await batch(args.denops, async (denops: Denops) => {
        await denops.call(
          "ddu#ui#ff#_update_buffer",
          args.uiParams,
          bufnr,
          floating ? this.popupId : await fn.bufwinid(args.denops, bufnr),
          this.items.map((c) => getPrefix(c) + (c.display ?? c.word)),
          args.uiParams.cursorPos >= 0 || (this.refreshed && checkRefreshed),
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
          }).slice(0, args.uiParams.maxHighlightItems).filter((item, index) =>
            item.highlights.length > 0 && !this.selectedItems.has(index)
          ),
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

    if (!initialized || cursorPos > 0) {
      // Save current cursor
      await args.denops.call("ddu#ui#ff#_save_cursor");
    }

    // Save cursor when cursor moved
    await args.denops.cmd(
      `autocmd ${augroupName} CursorMoved <buffer>` +
        " call ddu#ui#ff#_save_cursor()",
    );

    this.viewItems = Array.from(this.items);
    if (args.uiParams.reversed) {
      this.viewItems = this.viewItems.reverse();
    }

    const saveCursor = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_ff_save_cursor",
      { pos: [], text: "" },
    ) as SaveCursor;
    let currentText = "";
    if (saveCursor.pos.length !== 0) {
      const buflines = await fn.getbufline(
        args.denops,
        bufnr,
        saveCursor.pos[1],
      );
      if (buflines.length !== 0) {
        currentText = buflines[0];
      }
    }
    if (
      saveCursor.pos.length !== 0 && currentText === saveCursor.text
    ) {
      // Restore the cursor
      await args.denops.call(
        "ddu#ui#ff#_cursor",
        saveCursor.pos[1],
        saveCursor.pos[2],
      );
    }

    if (winid < 0) {
      const startFilter = args.uiParams.startFilter || (floating && !hasNvim);
      if (startFilter) {
        this.filterBufnr = await args.denops.call(
          "ddu#ui#ff#filter#_open",
          args.options.name,
          args.context.input,
          floating ? this.popupId : await fn.bufwinid(args.denops, bufnr),
          args.uiParams,
        ) as number;
      } else {
        await args.denops.cmd("stopinsert");
      }
    } else if (await fn.bufwinid(args.denops, this.filterBufnr) < 0) {
      await fn.win_gotoid(args.denops, winid);
    }

    if (this.enabledAutoAction) {
      // Call auto action
      await args.denops.call("ddu#ui#ff#_do_auto_action");
    }

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

  override expandItem(args: {
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
  }) {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const searchPath = JSON.stringify(args.parent.treePath);
    const index = this.items.findIndex(
      (item: DduItem) =>
        JSON.stringify(item.treePath) === searchPath &&
        item.__sourceIndex === args.parent.__sourceIndex,
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

    return Promise.resolve();
  }

  override collapseItem(args: {
    item: DduItem;
  }) {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const searchPath = JSON.stringify(args.item.treePath);
    const startIndex = this.items.findIndex(
      (item: DduItem) =>
        JSON.stringify(item.treePath) === searchPath &&
        item.__sourceIndex === args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return Promise.resolve();
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

    return Promise.resolve();
  }

  override async visible(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    tabNr: number;
  }): Promise<boolean> {
    // NOTE: Vim's floating window cannot find from buffer list.
    if (this.popupId > 0) {
      return true;
    }

    const bufnr = await this.getBufnr(args.denops);
    if (args.tabNr > 0) {
      return (await fn.tabpagebuflist(args.denops, args.tabNr) as number[])
        .includes(bufnr);
    } else {
      // Search from all tabpages.
      return (await fn.win_findbuf(args.denops, bufnr) as number[]).length > 0;
    }
  }

  override async winId(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<number> {
    const bufnr = await this.getBufnr(args.denops);
    const winIds = await fn.win_findbuf(args.denops, bufnr) as number[];
    return winIds.length > 0 ? winIds[0] : -1;
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
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const items = await this.getItems(args.denops);

      const actions = await args.denops.call(
        "ddu#get_item_actions",
        args.options.name,
        items,
      );

      await this.previewUi.close(args.denops, args.context, args.uiParams);
      await this.closeFilterWindow(args.denops);

      await args.denops.call("ddu#start", {
        name: args.options.name,
        push: true,
        sources: [
          {
            name: "action",
            options: {},
            params: {
              actions,
              name: args.options.name,
              items,
            },
          },
        ],
      });

      return ActionFlags.None;
    },
    clearSelectAllItems: (_) => {
      this.selectedItems.clear();
      return Promise.resolve(ActionFlags.Redraw);
    },
    collapseItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      return await this.collapseItemAction(args.denops, args.options);
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
    closePreviewWindow: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
    }) => {
      await this.previewUi.close(args.denops, args.context, args.uiParams);
      return ActionFlags.None;
    },
    cursorNext: async (args: {
      denops: Denops;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_ff_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0) {
        return ActionFlags.Persist;
      }

      const params = args.actionParams as CursorActionParams;
      const count = params.count ?? 1;
      const loop = params.loop ?? false;
      if (count === 0) {
        return ActionFlags.Persist;
      }

      // Move to the next
      if (args.uiParams.reversed) {
        cursorPos[1] -= count;
      } else {
        cursorPos[1] += count;
      }
      if (cursorPos[1] <= 0) {
        cursorPos[1] = loop ? this.viewItems.length : 1;
      } else if (cursorPos[1] > this.viewItems.length) {
        cursorPos[1] = loop ? 1 : this.viewItems.length;
      }

      await fn.setbufvar(
        args.denops,
        bufnr,
        "ddu_ui_ff_cursor_pos",
        cursorPos,
      );

      // Change real cursor
      await args.denops.call("ddu#ui#ff#_cursor", cursorPos[1], 0);

      return ActionFlags.Persist;
    },
    cursorPrevious: async (args: {
      denops: Denops;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_ff_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0) {
        return ActionFlags.Persist;
      }

      const params = args.actionParams as CursorActionParams;
      const count = params.count ?? 1;
      const loop = params.loop ?? false;
      if (count === 0) {
        return ActionFlags.Persist;
      }

      // Move to the previous
      if (args.uiParams.reversed) {
        cursorPos[1] += count;
      } else {
        cursorPos[1] -= count;
      }
      if (cursorPos[1] <= 0) {
        cursorPos[1] = loop ? this.viewItems.length : 1;
      } else if (cursorPos[1] > this.viewItems.length) {
        cursorPos[1] = loop ? 1 : this.viewItems.length;
      }

      await fn.setbufvar(
        args.denops,
        bufnr,
        "ddu_ui_ff_cursor_pos",
        cursorPos,
      );

      // Change real cursor
      await args.denops.call("ddu#ui#ff#_cursor", cursorPos[1], 0);

      return ActionFlags.Persist;
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: unknown;
    }) => {
      const item = await this.getItem(args.denops);
      if (!item) {
        return ActionFlags.None;
      }

      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode === "toggle") {
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
      const item = await this.getItem(args.denops);

      const bufnr = await this.getBufnr(args.denops);
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_item", item ?? {});

      const ft = await op.filetype.getLocal(args.denops);
      if (ft === "ddu-ff-filter") {
        // Set for filter window
        await vars.b.set(args.denops, "ddu_ui_item", item ?? {});
      }

      return ActionFlags.None;
    },
    getItems: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const bufnr = await this.getBufnr(args.denops);
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_items", this.items);

      const ft = await op.filetype.getLocal(args.denops);
      if (ft === "ddu-ff-filter") {
        // Set for filter window
        await vars.b.set(args.denops, "ddu_ui_items", this.items);
      }

      return ActionFlags.None;
    },
    getSelectedItems: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      const items = await this.getItems(args.denops);
      const bufnr = await this.getBufnr(args.denops);
      await fn.setbufvar(args.denops, bufnr, "ddu_ui_selected_items", items);

      const ft = await op.filetype.getLocal(args.denops);
      if (ft === "ddu-ff-filter") {
        // Set for filter window
        await vars.b.set(args.denops, "ddu_ui_selected_items", items);
      }

      return ActionFlags.None;
    },
    inputAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const items = await this.getItems(args.denops);

      const actions = await args.denops.call(
        "ddu#get_item_actions",
        args.options.name,
        items,
      );

      const actionName = await args.denops.call(
        "ddu#util#input_list",
        "Input action name: ",
        actions,
      );
      if (actionName !== "") {
        await args.denops.call(
          "ddu#item_action",
          args.options.name,
          actionName,
          items,
          {},
        );
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
      if (items.length === 0) {
        return ActionFlags.Persist;
      }

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
      actionParams: unknown;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseActionParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const uiParams = await this.resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );
      const reopenPreview = this.previewUi.visible() &&
        uiParams.split === "horizontal" && uiParams.previewSplit === "vertical";

      if (reopenPreview) {
        await this.previewUi.close(args.denops, args.context, uiParams);
      }

      this.filterBufnr = await args.denops.call(
        "ddu#ui#ff#filter#_open",
        args.options.name,
        args.context.input,
        uiParams.split === "floating"
          ? this.popupId
          : await fn.bufwinid(args.denops, await this.getBufnr(args.denops)),
        uiParams,
      ) as number;

      if (reopenPreview) {
        const item = await this.getItem(args.denops);
        if (!item || !args.getPreviewer) {
          return ActionFlags.None;
        }

        return this.previewUi.previewContents(
          args.denops,
          args.context,
          uiParams,
          args.actionParams,
          await this.getBufnr(args.denops),
          item,
          args.getPreviewer,
        );
      }

      return ActionFlags.None;
    },
    preview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseActionParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      const uiParams = await this.resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      return this.previewUi.previewContents(
        args.denops,
        args.context,
        uiParams,
        args.actionParams,
        await this.getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
    },
    previewExecute: async (args: {
      denops: Denops;
      actionParams: unknown;
    }) => {
      const command = (args.actionParams as PreviewExecuteParams).command;
      await this.previewUi.execute(args.denops, command);
      return ActionFlags.Persist;
    },
    previewPath: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
    }) => {
      const item = await this.getItem(args.denops);
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
    refreshItems: (_) => {
      return Promise.resolve(ActionFlags.RefreshItems);
    },
    toggleAllItems: (_) => {
      if (this.items.length === 0) {
        return Promise.resolve(ActionFlags.None);
      }

      this.items.forEach((_, idx) => {
        if (this.selectedItems.has(idx)) {
          this.selectedItems.delete(idx);
        } else {
          this.selectedItems.add(idx);
        }
      });

      return Promise.resolve(ActionFlags.Redraw);
    },
    toggleAutoAction: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
    }) => {
      // Toggle
      this.enabledAutoAction = !this.enabledAutoAction;

      const winid =
        (args.uiParams.split === "floating" && args.denops.meta.host !== "nvim")
          ? this.popupId
          : await fn.bufwinid(args.denops, await this.getBufnr(args.denops));
      await this.setAutoAction(args.denops, args.uiParams, winid);

      if (this.enabledAutoAction) {
        // Call auto action
        await args.denops.call("ddu#ui#ff#_do_auto_action");
      } else {
        await this.previewUi.close(args.denops, args.context, args.uiParams);
      }

      return ActionFlags.None;
    },
    togglePreview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: unknown;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseActionParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      // Close if the target is the same as the previous one
      if (this.previewUi.isAlreadyPreviewed(item)) {
        await this.previewUi.close(args.denops, args.context, args.uiParams);
        return ActionFlags.None;
      }

      const uiParams = await this.resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      return this.previewUi.previewContents(
        args.denops,
        args.context,
        uiParams,
        args.actionParams,
        await this.getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
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
      exprParams: [
        "previewCol",
        "previewRow",
        "previewHeight",
        "previewWidth",
        "winCol",
        "winRow",
        "winHeight",
        "winWidth",
      ],
      filterFloatingPosition: "top",
      filterSplitDirection: "aboveleft",
      filterFloatingTitle: "",
      filterFloatingTitlePos: "left",
      filterUpdateTime: 0,
      floatingBorder: "none",
      floatingTitle: "",
      floatingTitlePos: "left",
      highlights: {},
      ignoreEmpty: false,
      immediateAction: "",
      maxDisplayItems: 1000,
      maxHighlightItems: 100,
      onPreview: (_) => {
        return Promise.resolve();
      },
      previewCol: 0,
      previewFloating: false,
      previewFloatingBorder: "none",
      previewFloatingTitle: "",
      previewFloatingTitlePos: "left",
      previewFloatingZindex: 100,
      previewHeight: 10,
      previewRow: 0,
      previewSplit: "horizontal",
      previewWidth: 80,
      previewWindowOptions: [
        ["&signcolumn", "no"],
        ["&foldcolumn", 0],
        ["&foldenable", 0],
        ["&number", 0],
        ["&wrap", 0],
      ],
      prompt: "",
      reversed: false,
      replaceCol: 0,
      split: "horizontal",
      splitDirection: "botright",
      startAutoAction: false,
      startFilter: false,
      statusline: true,
      winCol: "(&columns - eval(uiParams.winWidth)) / 2",
      winHeight: 20,
      winRow: "&lines / 2 - 10",
      winWidth: "&columns / 2",
    };
  }

  private async closeBuffer(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    cancel: boolean;
  }): Promise<void> {
    await this.previewUi.close(args.denops, args.context, args.uiParams);
    await this.previewUi.removePreviewedBuffers(args.denops);
    await this.closeFilterWindow(args.denops);
    await args.denops.call("ddu#ui#ff#_reset_auto_action");
    await args.denops.call("ddu#ui#ff#_restore_title");

    // Move to the UI window.
    const bufnr = await this.getBufnr(args.denops);
    if (!bufnr) {
      return;
    }

    if (
      args.uiParams.split === "floating" && args.denops.meta.host !== "nvim" &&
      this.popupId > 0
    ) {
      // Close popup
      await args.denops.call("popup_close", this.popupId);
      await args.denops.cmd("redraw!");
      this.popupId = -1;
    } else {
      for (
        const winid of (await fn.win_findbuf(args.denops, bufnr) as number[])
      ) {
        if (winid <= 0) {
          continue;
        }

        await fn.win_gotoid(args.denops, winid);
        await this.closeFilterWindow(args.denops);

        if (
          args.uiParams.split === "no" ||
          (await fn.winnr(args.denops, "$")) === 1
        ) {
          const prevName = await fn.bufname(args.denops, args.context.bufNr);
          await args.denops.cmd(
            prevName !== args.context.bufName || args.context.bufNr == bufnr
              ? "enew"
              : `buffer ${args.context.bufNr}`,
          );
        } else {
          await args.denops.cmd("close!");
          await fn.win_gotoid(args.denops, args.context.winId);
        }
      }
    }

    // Restore mode
    if (this.saveMode === "i") {
      if (!args.cancel && args.uiParams.replaceCol > 0) {
        const currentLine = await fn.getline(args.denops, ".");
        const replaceLine = currentLine.slice(
          0,
          args.uiParams.replaceCol - 1,
        ) + currentLine.slice(this.saveCol - 1);
        await fn.setline(args.denops, ".", replaceLine);
        await fn.cursor(args.denops, 0, args.uiParams.replaceCol - 1);
      }

      const endCol = await fn.col(args.denops, ".");
      await fn.feedkeys(
        args.denops,
        args.uiParams.replaceCol > 1 || this.saveCol > endCol ? "a" : "i",
        "n",
      );
    } else if (this.saveMode === ":") {
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
    if (this.selectedItems.size === 0) {
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
    floating: boolean,
    augroupName: string,
  ): Promise<void> {
    const statusState = {
      done: context.done,
      input: context.input,
      name: options.name,
      maxItems: context.maxItems,
    };
    const winid = (floating && denops.meta.host !== "nvim")
      ? this.popupId
      : await fn.bufwinid(denops, bufnr);
    await fn.setwinvar(
      denops,
      winid,
      "ddu_ui_ff_status",
      statusState,
    );

    if (!uiParams.statusline) {
      return;
    }

    const header = `[ddu-${options.name}]` +
      (this.items.length !== context.maxItems
        ? ` ${this.items.length}/${context.maxItems}`
        : "");
    const async = `${context.done ? "" : " [async]"}`;

    if (floating || await op.laststatus.get(denops) === 0) {
      if (await vars.g.get(denops, "ddu#ui#ff#_save_title", "") === "") {
        await vars.g.set(
          denops,
          "ddu#ui#ff#_save_title",
          await op.titlestring.get(denops),
        );
      }

      await denops.cmd(
        `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
          " call ddu#ui#ff#_restore_title()",
      );
      await denops.cmd(
        `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
          " call ddu#ui#ff#_set_title(str2nr(expand('<abuf>')))",
      );

      const titleString = `${header}${async}`;
      await vars.b.set(denops, "ddu_ui_ff_title", titleString);

      await denops.call("ddu#ui#ff#_set_title", bufnr);
    } else {
      const linenr = "printf('%'.(len(line('$'))).'d/%d',line('.'),line('$'))";
      await fn.setwinvar(
        denops,
        winid,
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
    const item = await this.getItem(denops);
    if (!item || !item.isTree) {
      return ActionFlags.None;
    }

    await denops.call(
      "ddu#redraw_tree",
      options.name,
      "collapse",
      [{ item }],
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
    const existsStatusColumn = await fn.exists(denops, "+statuscolumn");

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      if (existsStatusColumn) {
        await fn.setwinvar(denops, winid, "&statuscolumn", "");
      }

      await fn.setbufvar(denops, bufnr, "&bufhidden", "unload");
      await fn.setbufvar(denops, bufnr, "&buftype", "nofile");
      await fn.setbufvar(denops, bufnr, "&filetype", "ddu-ff");
      await fn.setbufvar(denops, bufnr, "&swapfile", 0);

      if (uiParams.split === "horizontal") {
        await fn.setwinvar(denops, winid, "&winfixheight", 1);
      } else if (uiParams.split === "vertical") {
        await fn.setwinvar(denops, winid, "&winfixwidth", 1);
      }
    });
  }

  private async resolveParams(
    denops: Denops,
    options: DduOptions,
    uiParams: Params,
    context: Record<string, unknown>,
  ): Promise<Params> {
    const defaults = this.params();

    context = {
      sources: options.sources.map(
        (source) => is.String(source) ? source : source.name,
      ),
      itemCount: this.items.length,
      uiParams,
      ...context,
    };

    const params = Object.assign(uiParams);
    for (const name of uiParams.exprParams) {
      if (name in uiParams) {
        params[name] = await this.evalExprParam(
          denops,
          name,
          params[name],
          defaults[name],
          context,
        );
      } else {
        await denops.call(
          "ddu#util#print_error",
          `Invalid expr param: ${name}`,
        );
      }
    }

    return params;
  }

  private async evalExprParam(
    denops: Denops,
    name: string,
    expr: string | unknown,
    defaultExpr: string | unknown,
    context: Record<string, unknown>,
  ): Promise<unknown> {
    if (!is.String(expr)) {
      return expr;
    }

    try {
      return await denops.eval(expr, context);
    } catch (e) {
      await errorException(
        denops,
        e,
        `[ddu-ui-ff] invalid expression in option: ${name}`,
      );

      // Fallback to default param.
      return is.String(defaultExpr)
        ? await denops.eval(defaultExpr, context)
        : defaultExpr;
    }
  }

  private async getBufnr(
    denops: Denops,
  ): Promise<number> {
    return await fn.bufnr(denops, this.bufferName);
  }

  private async getIndex(
    denops: Denops,
  ): Promise<number> {
    const bufnr = await this.getBufnr(denops);
    const cursorPos = await fn.getbufvar(
      denops,
      bufnr,
      "ddu_ui_ff_cursor_pos",
      [],
    ) as number[];
    if (cursorPos.length === 0) {
      return -1;
    }

    const viewItem = this.viewItems[cursorPos[1] - 1];
    return this.items.findIndex(
      (item: DduItem) => item === viewItem,
    );
  }

  private async setAutoAction(denops: Denops, uiParams: Params, winId: number) {
    const hasAutoAction = "name" in uiParams.autoAction &&
      this.enabledAutoAction;

    await batch(denops, async (denops: Denops) => {
      await denops.call("ddu#ui#ff#_reset_auto_action");
      if (hasAutoAction) {
        const autoAction = Object.assign(
          { delay: 100, params: {}, sync: true },
          uiParams.autoAction,
        );
        await denops.call(
          "ddu#ui#ff#_set_auto_action",
          winId,
          autoAction,
        );
      }
    });
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
