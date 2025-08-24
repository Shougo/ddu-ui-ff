import {
  ActionFlags,
  type BaseParams,
  type Context,
  type DduItem,
  type DduOptions,
  type PreviewContext,
  type Previewer,
  type UiOptions,
} from "@shougo/ddu-vim/types";
import { BaseUi, type UiActions } from "@shougo/ddu-vim/ui";
import { convertTreePath, printError } from "@shougo/ddu-vim/utils";

import type { Denops } from "@denops/std";
import { batch } from "@denops/std/batch";
import * as op from "@denops/std/option";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";

import { equal } from "@std/assert";
import { is } from "@core/unknownutil/is";
import { SEPARATOR as pathsep } from "@std/path/constants";
import { ensure } from "@denops/std/buffer";

import { PreviewUi } from "./preview.ts";

type HighlightGroup = {
  filterText?: string;
  floating?: string;
  floatingBorder?: string;
  floatingCursorLine?: string;
  preview?: string;
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

type CursorPos = [] | [lnum: number, col: number, off?: number];

type ExprNumber = string | number;

type WinInfo = {
  columns: number;
  lines: number;
  winid: number;
  tabpagebuflist: number[];
};

type DoActionParams = {
  name?: string;
  items?: DduItem[];
  params?: unknown;
};

type CursorActionParams = {
  count?: number;
  loop?: boolean;
};

type ExpandItemParams = {
  mode?: "toggle";
  maxLevel?: number;
  isGrouped?: boolean;
  isInTree?: boolean;
};

type OpenFilterWindowParams = {
  input?: string;
};

type OnPreviewArguments = {
  denops: Denops;
  context: Context;
  item: DduItem;
  previewContext: PreviewContext;
  previewWinId: number;
};

type PreviewExecuteParams = {
  command: string;
};

type RedrawParams = {
  method?: "refreshItems" | "uiRedraw" | "uiRefresh";
};

type QuitParams = {
  force?: boolean;
};

export type Params = {
  autoAction: AutoAction;
  autoResize: boolean;
  cursorPos: number;
  displaySourceName: "long" | "short" | "no";
  displayTree: boolean;
  exprParams: (keyof Params)[];
  floatingBorder: FloatingBorder;
  floatingTitle: FloatingTitle;
  floatingTitlePos: "left" | "center" | "right";
  focus: boolean;
  highlights: HighlightGroup;
  ignoreEmpty: boolean;
  immediateAction: string;
  maxDisplayItems: number;
  maxHighlightItems: number;
  maxWidth: number;
  onPreview: string | ((args: OnPreviewArguments) => Promise<void>);
  pathFilter: string;
  previewCol: ExprNumber;
  previewFocusable: boolean;
  previewFloating: boolean;
  previewFloatingBorder: FloatingBorder;
  previewFloatingTitle: FloatingTitle;
  previewFloatingTitlePos: "left" | "center" | "right";
  previewFloatingZindex: number;
  previewHeight: ExprNumber;
  previewMaxSize: number;
  previewRow: ExprNumber;
  previewSplit: "horizontal" | "vertical" | "no";
  previewWidth: ExprNumber;
  previewWindowOptions: WindowOption[];
  replaceCol: number;
  reversed: boolean;
  split: "horizontal" | "vertical" | "floating" | "tab" | "no";
  splitDirection: "belowright" | "aboveleft" | "topleft" | "botright";
  startAutoAction: boolean;
  statusline: boolean;
  winCol: ExprNumber;
  winHeight: ExprNumber;
  winRow: ExprNumber;
  winWidth: ExprNumber;
};

export class Ui extends BaseUi<Params> {
  #bufferName = "";
  #items: DduItem[] = [];
  #viewItems: DduItem[] = [];
  #selectedItems: ObjectSet<DduItem> = new ObjectSet();
  #saveMode = "";
  #saveCmdline = "";
  #saveCmdpos = 0;
  #saveCol = 0;
  #refreshed = false;
  #prevLength = -1;
  #prevInput = "";
  #prevWinInfo: WinInfo | null = null;
  #previewUi = new PreviewUi();
  #popupId = -1;
  #enabledAutoAction = false;
  #restcmd = "";
  #closing = false;

  override async onInit(args: {
    denops: Denops;
    uiParams: Params;
  }): Promise<void> {
    this.#saveMode = await fn.mode(args.denops);
    if (this.#saveMode === "c") {
      this.#saveMode = await fn.getcmdtype(args.denops) as string;
      if (this.#saveMode === ":") {
        // Save command line state
        this.#saveCmdline = await fn.getcmdline(args.denops) as string;
        this.#saveCmdpos = await fn.getcmdpos(args.denops) as number;
      }
    } else {
      this.#saveCol = await fn.col(args.denops, ".") as number;
    }

    this.#items = [];
    await this.clearSelectedItems(args);

    this.#enabledAutoAction = args.uiParams.startAutoAction;

    await this.#clearSavedCursor(args.denops);
  }

  override async onBeforeAction(args: {
    denops: Denops;
  }): Promise<void> {
    await vars.g.set(args.denops, "ddu#ui#ff#_in_action", true);

    const bufnr = await fn.bufnr(args.denops, this.#bufferName);
    if (await fn.bufnr(args.denops, "%") === bufnr) {
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
    this.#prevLength = this.#items.length;
    this.#prevInput = args.context.input;

    this.#items = args.items.slice(0, args.uiParams.maxDisplayItems);
    if (args.uiParams.pathFilter !== "") {
      const pathFilter = new RegExp(args.uiParams.pathFilter);
      type ActionPath = {
        path: string;
      };
      this.#items = this.#items.filter((item) =>
        (item?.action as ActionPath)?.path &&
        pathFilter.test((item?.action as ActionPath)?.path)
      );
    }

    await this.#updateSelectedItems(args.denops);

    this.#refreshed = true;

    await this.#clearSavedCursor(args.denops);

    return Promise.resolve();
  }

  override async searchItem(args: {
    denops: Denops;
    context: Context;
    item: DduItem;
    uiParams: Params;
  }) {
    const bufnr = await this.#getBufnr(args.denops);
    if (bufnr !== await fn.bufnr(args.denops)) {
      return;
    }

    let index = this.#items.findIndex(
      (item) => equal(item, args.item),
    );
    if (index < 0) {
      // NOTE: Use treePath to search item.  Because item state may be changed.
      const itemTreePath = convertTreePath(
        args.item.treePath ?? args.item.word,
      );
      index = this.#items.findIndex(
        (item) =>
          equal(convertTreePath(item.treePath ?? item.word), itemTreePath),
      );
    }

    if (index < 0) {
      return;
    }

    // NOTE: cursorPos is not same with item pos when reversed.
    const cursorPos = args.uiParams.reversed
      ? this.#items.length - index
      : index + 1;

    const winHeight = await fn.winheight(args.denops, 0);
    const maxLine = await fn.line(args.denops, "$");
    if ((maxLine - cursorPos) < winHeight / 2) {
      // Adjust cursor position when cursor is near bottom.
      await args.denops.cmd("normal! Gzb");
    }
    await this.#cursor(args.denops, args.context, [cursorPos, 0]);
    if (cursorPos < winHeight / 2) {
      // Adjust cursor position when cursor is near top.
      await args.denops.cmd("normal! zb");
    }

    await args.denops.call("ddu#ui#ff#_update_cursor");
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

    if (args.context.done && this.#items.length === 0) {
      // Close preview window when empty items
      await this.#previewUi.close(args.denops, args.context, args.uiParams);
    }

    this.#bufferName = `ddu-ff-${args.options.name}`;

    const existsUI = await this.#winId({
      denops: args.denops,
      uiParams: args.uiParams,
    }) > 0;

    if (!existsUI) {
      if (args.uiParams.ignoreEmpty && this.#items.length === 0) {
        // Disable open UI window when empty items
        return;
      }

      if (
        args.uiParams.immediateAction.length != 0 &&
        this.#items.length === 1
      ) {
        // Immediate action
        await args.denops.call(
          "ddu#item_action",
          args.options.name,
          args.uiParams.immediateAction,
          this.#items,
          {},
        );
        return;
      }
    }

    const initialized = await fn.bufexists(args.denops, this.#bufferName) &&
      await fn.bufnr(args.denops, this.#bufferName);

    const bufnr = initialized ||
      await initBuffer(args.denops, this.#bufferName);

    const augroupName = `ddu-ui-ff-${bufnr}`;
    await args.denops.cmd(`augroup ${augroupName}`);
    await args.denops.cmd(`autocmd! ${augroupName}`);

    args.uiParams = await this.#resolveParams(
      args.denops,
      args.options,
      args.uiParams,
      args.context,
    );

    const hasNvim = args.denops.meta.host === "nvim";
    //const floating = args.uiParams.split === "floating";
    const floating = args.uiParams.split === "floating" && hasNvim;
    const winWidth = Number(args.uiParams.winWidth);
    let winHeight = args.uiParams.autoResize &&
        this.#items.length < Number(args.uiParams.winHeight)
      ? Math.max(this.#items.length, 1)
      : Number(args.uiParams.winHeight);
    const prevWinid = await this.#winId({
      denops: args.denops,
      uiParams: args.uiParams,
    });

    if (prevWinid < 0) {
      // The layout must be saved.
      this.#restcmd = await fn.winrestcmd(args.denops);
      this.#prevWinInfo = await getWinInfo(args.denops);
    }

    const direction = args.uiParams.splitDirection;
    if (args.uiParams.split === "horizontal") {
      // NOTE: If winHeight is bigger than `&lines / 2`, it will be resized.
      const maxWinHeight = Math.floor(
        await op.lines.getGlobal(args.denops) * 4 / 10,
      );
      if (winHeight > maxWinHeight) {
        winHeight = maxWinHeight;
      }

      if (prevWinid >= 0) {
        await fn.win_execute(
          args.denops,
          prevWinid,
          `resize ${winHeight}`,
        );
      } else {
        const header = `silent keepalt ${direction} `;
        await args.denops.cmd(
          header + `sbuffer +resize\\ ${winHeight} ${bufnr}`,
        );
      }
    } else if (args.uiParams.split === "vertical") {
      if (prevWinid >= 0) {
        await fn.win_execute(
          args.denops,
          prevWinid,
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
      const currentStatusline = await op.statusline.getLocal(args.denops);
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
        if (
          this.#popupId >= 0 &&
          await fn.bufwinid(args.denops, bufnr) === this.#popupId
        ) {
          try {
            await args.denops.call(
              "nvim_win_set_config",
              this.#popupId,
              winOpts,
            );
          } catch (_) {
            // The window may be closed.
          }
        } else {
          this.#popupId = await args.denops.call(
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
          "focusable": 1,
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
        if (
          this.#popupId >= 0 &&
          await fn.bufwinid(args.denops, bufnr) === this.#popupId
        ) {
          await args.denops.call(
            "popup_move",
            this.#popupId,
            winOpts,
          );
        } else {
          this.#popupId = await args.denops.call(
            "popup_create",
            bufnr,
            winOpts,
          ) as number;
        }
      }

      if (hasNvim) {
        await fn.setwinvar(
          args.denops,
          this.#popupId,
          "&winhighlight",
          `Normal:${floatingHighlight},FloatBorder:${borderHighlight},` +
            `CursorLine:${cursorLineHighlight}`,
        );

        await fn.setwinvar(
          args.denops,
          this.#popupId,
          "&statusline",
          currentStatusline,
        );
      } else {
        await fn.setwinvar(
          args.denops,
          this.#popupId,
          "&cursorline",
          true,
        );

        if (cursorLineHighlight !== "CursorLine") {
          await fn.win_execute(
            args.denops,
            this.#popupId,
            `highlight! link CursorLine ${cursorLineHighlight}`,
          );
        }
      }
    } else if (args.uiParams.split === "tab") {
      if (prevWinid >= 0) {
        await fn.win_gotoid(args.denops, prevWinid);
      } else {
        // NOTE: ":tabnew" creates new empty buffer.
        await args.denops.cmd(`silent keepalt tab sbuffer ${bufnr}`);
      }
    } else if (args.uiParams.split === "no") {
      if (prevWinid < 0) {
        await args.denops.cmd(`silent keepalt buffer ${bufnr}`);
      }
    } else {
      await printError(
        args.denops,
        `Invalid split param: ${args.uiParams.split}`,
      );
      return;
    }

    const winid = await this.#winId({
      denops: args.denops,
      uiParams: args.uiParams,
    });

    await this.#setAutoAction(args.denops, args.uiParams, winid);

    const prevWinnr = await fn.winnr(args.denops, "#");
    if (
      args.uiParams.autoResize && prevWinnr > 0 &&
      prevWinnr !== await fn.winnr(args.denops)
    ) {
      await fn.win_execute(
        args.denops,
        winid,
        `resize ${winHeight} | normal! zb`,
      );
    }

    if (!initialized || winid < 0) {
      await this.#initOptions(args.denops, args.options, args.uiParams, bufnr);
    }
    if (!initialized) {
      // Update cursor when cursor moved
      await args.denops.cmd(
        "autocmd CursorMoved <buffer> call ddu#ui#ff#_update_cursor()",
      );
    }

    await setStatusline(
      args.denops,
      args.context,
      args.options,
      args.uiParams,
      await this.#winId({
        denops: args.denops,
        uiParams: args.uiParams,
      }),
      floating,
      augroupName,
      this.#items,
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
    const cursorPos = Number(args.uiParams.cursorPos) > 0 && this.#refreshed &&
        this.#prevLength == 0
      ? Number(args.uiParams.cursorPos)
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
      const checkRefreshed = args.context.input !== this.#prevInput ||
        (this.#prevLength > 0 && this.#items.length < this.#prevLength) ||
        (args.uiParams.reversed && this.#items.length !== this.#prevLength);
      // NOTE: Use batch for screen flicker when highlight items.
      await batch(args.denops, async (denops: Denops) => {
        await ensure(args.denops, bufnr, async () => {
          await denops.call(
            "ddu#ui#ff#_update_buffer",
            args.uiParams,
            bufnr,
            winid,
            this.#items.map((c) => getPrefix(c) + (c.display ?? c.word)),
            args.uiParams.cursorPos > 0 || (this.#refreshed && checkRefreshed),
            cursorPos,
          );
          await denops.call(
            "ddu#ui#ff#_process_items",
            args.uiParams,
            bufnr,
            this.#items.length,
            this.#items.map((item, index) => {
              return {
                highlights: item.highlights ?? [],
                info: item.info ?? [],
                row: index + 1,
                prefix: getPrefix(item),
              };
            }).slice(0, args.uiParams.maxHighlightItems),
            this.#selectedItems.values()
              .map((item) => this.#getItemIndex(item))
              .filter((index) => index >= 0),
          );
        });
      });
    } catch (e) {
      await printError(
        args.denops,
        e,
        "[ddu-ui-ff] update buffer failed",
      );
      return;
    }

    this.#viewItems = Array.from(this.#items);
    if (args.uiParams.reversed) {
      this.#viewItems = this.#viewItems.reverse();
    }

    const saveItem = await fn.getbufvar(
      args.denops,
      bufnr,
      "ddu_ui_item",
      {},
    ) as DduItem;

    if (cursorPos <= 0 && Object.keys(saveItem).length !== 0) {
      this.searchItem({
        denops: args.denops,
        context: args.context,
        item: saveItem,
        uiParams: args.uiParams,
      });
    }

    if (!initialized || cursorPos > 0) {
      // Update current cursor
      await this.updateCursor({ denops: args.denops, context: args.context });
    }

    await this.#doAutoAction(args.denops);

    await fn.setbufvar(args.denops, bufnr, "ddu_ui_items", this.#items);

    await fn.win_gotoid(
      args.denops,
      args.uiParams.focus ? winid : args.context.winId,
    );

    this.#refreshed = false;
  }

  override async clearSelectedItems(args: {
    denops: Denops;
  }) {
    this.#selectedItems.clear();
    const bufnr = await this.#getBufnr(args.denops);
    await fn.setbufvar(args.denops, bufnr, "ddu_ui_selected_items", []);
  }

  override async quit(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
  }): Promise<void> {
    await this.#close({
      denops: args.denops,
      context: args.context,
      options: args.options,
      uiParams: args.uiParams,
      cancel: false,
    });
  }

  override async expandItem(args: {
    denops: Denops;
    uiParams: Params;
    parent: DduItem;
    children: DduItem[];
    isGrouped: boolean;
  }): Promise<number> {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const index = this.#items.findIndex(
      (item: DduItem) =>
        equal(item.treePath, args.parent.treePath) &&
        item.__sourceIndex === args.parent.__sourceIndex,
    );

    const insertItems = args.children;

    const prevLength = this.#items.length;
    if (index >= 0) {
      if (args.isGrouped) {
        // Replace parent
        this.#items[index] = insertItems[0];
      } else {
        this.#items = this.#items.slice(0, index + 1).concat(insertItems)
          .concat(
            this.#items.slice(index + 1),
          );
        this.#items[index] = args.parent;
      }
    } else {
      this.#items = this.#items.concat(insertItems);
    }

    await this.#updateSelectedItems(args.denops);

    return Promise.resolve(prevLength - this.#items.length);
  }

  override async collapseItem(args: {
    denops: Denops;
    item: DduItem;
  }): Promise<number> {
    // NOTE: treePath may be list.  So it must be compared by JSON.
    const startIndex = this.#items.findIndex(
      (item: DduItem) =>
        equal(item.treePath, args.item.treePath) &&
        item.__sourceIndex === args.item.__sourceIndex,
    );
    if (startIndex < 0) {
      return Promise.resolve(0);
    }

    const endIndex = this.#items.slice(startIndex + 1).findIndex(
      (item: DduItem) => item.__level <= args.item.__level,
    );

    const prevLength = this.#items.length;
    if (endIndex < 0) {
      this.#items = this.#items.slice(0, startIndex + 1);
    } else {
      this.#items = this.#items.slice(0, startIndex + 1).concat(
        this.#items.slice(startIndex + endIndex + 1),
      );
    }

    this.#items[startIndex] = args.item;

    await this.#updateSelectedItems(args.denops);

    return Promise.resolve(prevLength - this.#items.length);
  }

  override async visible(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    tabNr: number;
  }): Promise<boolean> {
    // NOTE: Vim's floating window cannot find from buffer list.
    if (this.#popupId > 0) {
      return true;
    }

    const bufnr = await this.#getBufnr(args.denops);
    if (args.tabNr > 0) {
      return (await fn.tabpagebuflist(args.denops, args.tabNr) as number[])
        .includes(bufnr);
    } else {
      // Search from all tabpages.
      return (await fn.win_findbuf(args.denops, bufnr) as number[]).length > 0;
    }
  }

  async #winId(args: {
    denops: Denops;
    uiParams: Params;
  }): Promise<number> {
    // NOTE: In Vim popup window, win_findbuf()/winbufnr() does not work.
    if (
      args.uiParams.split === "floating" &&
      args.denops.meta.host !== "nvim" && this.#popupId > 0
    ) {
      return this.#popupId;
    }

    const bufnr = await this.#getBufnr(args.denops);
    const winIds = await fn.win_findbuf(args.denops, bufnr) as number[];
    return winIds.length > 0 ? winIds[0] : -1;
  }

  override async winIds(args: {
    denops: Denops;
    uiParams: Params;
  }): Promise<number[]> {
    const winIds = [];

    const mainWinId = await this.#winId(args);
    if (mainWinId > 0) {
      winIds.push(mainWinId);
    }

    if (this.#previewUi.visible()) {
      winIds.push(this.#previewUi.previewWinId);
    }

    return winIds;
  }

  override async updateCursor(args: {
    denops: Denops;
    context: Context;
  }) {
    const item = await this.#getItem(args.denops);
    const bufnr = await this.#getBufnr(args.denops);
    await fn.setbufvar(args.denops, bufnr, "ddu_ui_item", item ?? {});
  }

  override actions: UiActions<Params> = {
    checkItems: (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      args.denops.dispatcher.redraw(args.options.name, {
        check: true,
        method: "refreshItems",
      });

      return ActionFlags.None;
    },
    chooseAction: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const items = await this.#getItems(args.denops);

      await this.#previewUi.close(args.denops, args.context, args.uiParams);

      await args.denops.dispatcher.start({
        name: args.options.name,
        push: true,
        sources: [
          {
            name: "action",
            params: {
              name: args.options.name,
              items,
            },
          },
        ],
      });

      return ActionFlags.None;
    },
    chooseInput: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      await this.#previewUi.close(args.denops, args.context, args.uiParams);

      await args.denops.dispatcher.start({
        name: args.options.name,
        push: true,
        sources: [
          {
            name: "input_history",
            params: {
              name: args.options.name,
            },
          },
        ],
      });

      return ActionFlags.None;
    },
    clearSelectAllItems: async (args: {
      denops: Denops;
    }) => {
      await this.clearSelectedItems(args);

      return Promise.resolve(ActionFlags.Redraw);
    },
    collapseItem: async (args: {
      denops: Denops;
      options: DduOptions;
    }) => {
      return await this.#collapseItemAction(args.denops, args.options);
    },
    closePreviewWindow: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
    }) => {
      await this.#previewUi.close(args.denops, args.context, args.uiParams);
      return ActionFlags.None;
    },
    cursorNext: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
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
        cursorPos[1] = loop ? this.#viewItems.length : 1;
      } else if (cursorPos[1] > this.#viewItems.length) {
        cursorPos[1] = loop ? 1 : this.#viewItems.length;
      }

      await this.#cursor(args.denops, args.context, [
        cursorPos[1],
        cursorPos[2],
      ]);

      const floating = args.uiParams.split === "floating" &&
        args.denops.meta.host === "nvim";

      await setStatusline(
        args.denops,
        args.context,
        args.options,
        args.uiParams,
        await this.#winId({
          denops: args.denops,
          uiParams: args.uiParams,
        }),
        floating,
        `ddu-ui-ff-${bufnr}`,
        this.#items,
      );

      return ActionFlags.Persist;
    },
    cursorPrevious: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
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
        cursorPos[1] = loop ? this.#viewItems.length : 1;
      } else if (cursorPos[1] > this.#viewItems.length) {
        cursorPos[1] = loop ? 1 : this.#viewItems.length;
      }

      await this.#cursor(args.denops, args.context, [
        cursorPos[1],
        cursorPos[2],
      ]);

      const floating = args.uiParams.split === "floating" &&
        args.denops.meta.host === "nvim";

      await setStatusline(
        args.denops,
        args.context,
        args.options,
        args.uiParams,
        await this.#winId({
          denops: args.denops,
          uiParams: args.uiParams,
        }),
        floating,
        `ddu-ui-ff-${bufnr}`,
        this.#items,
      );

      return ActionFlags.Persist;
    },
    cursorTreeBottom: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_ff_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0 || !cursorPos[1] || !cursorPos[2]) {
        return ActionFlags.Persist;
      }

      // Search tree top
      const item = await this.#getItem(args.denops);
      const targetLevel = item?.__level ?? 0;
      let idx = await this.#getIndex(args.denops);
      let minIndex = idx;

      while (idx < this.#viewItems.length) {
        if (this.#viewItems[idx].__level === targetLevel) {
          minIndex = idx;
        }
        if (this.#viewItems[idx].__level < targetLevel) {
          break;
        }

        idx++;
      }
      cursorPos[1] = minIndex + 1;

      await this.#cursor(args.denops, args.context, [
        cursorPos[1],
        cursorPos[2],
      ]);

      return ActionFlags.Persist;
    },
    cursorTreeTop: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const bufnr = await this.#getBufnr(args.denops);
      const cursorPos = await fn.getbufvar(
        args.denops,
        bufnr,
        "ddu_ui_ff_cursor_pos",
        [],
      ) as number[];
      if (cursorPos.length === 0 || !cursorPos[1] || !cursorPos[2]) {
        return ActionFlags.Persist;
      }

      // Search tree top
      const item = await this.#getItem(args.denops);
      const targetLevel = item?.__level ?? 0;
      let idx = await this.#getIndex(args.denops);
      let minIndex = idx;

      while (idx >= 0) {
        if (this.#viewItems[idx].__level === targetLevel) {
          minIndex = idx;
        }
        if (this.#viewItems[idx].__level < targetLevel) {
          break;
        }

        idx--;
      }
      cursorPos[1] = minIndex + 1;

      await this.#cursor(args.denops, args.context, [
        cursorPos[1],
        cursorPos[2],
      ]);

      return ActionFlags.Persist;
    },
    expandItem: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: BaseParams;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item) {
        return ActionFlags.None;
      }

      const params = args.actionParams as ExpandItemParams;

      if (item.__expanded) {
        if (params.mode === "toggle") {
          return await this.#collapseItemAction(args.denops, args.options);
        }
        return ActionFlags.None;
      }

      await args.denops.dispatcher.redrawTree(
        args.options.name,
        "expand",
        [{
          item,
          maxLevel: params.maxLevel ?? 0,
          isGrouped: params.isGrouped ?? false,
          isInTree: params.isInTree ?? false,
        }],
      );

      return ActionFlags.None;
    },
    inputAction: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const items = await this.#getItems(args.denops);

      const actions = await args.denops.dispatcher.getItemActionNames(
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
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as DoActionParams;

      const items = params.items ?? await this.#getItems(args.denops);
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
    openFilterWindow: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiOptions: UiOptions;
      uiParams: Params;
      actionParams: BaseParams;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
      inputHistory: string[];
    }) => {
      const uiParams = await this.#resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );
      const reopenPreview = this.#previewUi.visible() &&
        uiParams.split === "horizontal" && uiParams.previewSplit === "vertical";

      if (reopenPreview) {
        await this.#previewUi.close(args.denops, args.context, uiParams);
      }

      const actionParams = args.actionParams as OpenFilterWindowParams;

      args.context.input = await args.denops.call(
        "ddu#ui#_open_filter_window",
        args.uiOptions,
        actionParams.input ?? args.context.input,
        args.options.name,
        this.#items.length,
        args.inputHistory,
      ) as string;

      if (reopenPreview) {
        const item = await this.#getItem(args.denops);
        if (!item || !args.getPreviewer) {
          return ActionFlags.None;
        }

        return this.#previewUi.previewContents(
          args.denops,
          args.context,
          uiParams,
          args.actionParams,
          await this.#getBufnr(args.denops),
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
      actionParams: BaseParams;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      const uiParams = await this.#resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      return this.#previewUi.previewContents(
        args.denops,
        args.context,
        uiParams,
        args.actionParams,
        await this.#getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
    },
    previewExecute: async (args: {
      denops: Denops;
      actionParams: BaseParams;
    }) => {
      const command = (args.actionParams as PreviewExecuteParams).command;
      await this.#previewUi.execute(args.denops, command);
      return ActionFlags.Persist;
    },
    previewPath: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item) {
        return ActionFlags.None;
      }

      await args.denops.cmd(`echo '${item.display ?? item.word}'`);

      return ActionFlags.Persist;
    },
    quit: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
    }) => {
      const params = args.actionParams as QuitParams;

      await this.#close({
        denops: args.denops,
        context: args.context,
        options: args.options,
        uiParams: args.uiParams,
        cancel: true,
      });

      await args.denops.cmd("doautocmd <nomodeline> User Ddu:uiQuit");

      if (params.force) {
        const bufnr = await this.#getBufnr(args.denops);
        if (bufnr && await fn.bufexists(args.denops, this.#bufferName)) {
          await args.denops.cmd(`bwipeout! ${bufnr}`);
        }
      } else {
        await args.denops.dispatcher.pop(args.options.name);
      }

      return ActionFlags.None;
    },
    redraw: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      actionParams: BaseParams;
      uiParams: Params;
    }) => {
      if (this.#previewUi.visible()) {
        // Close preview window when redraw
        await this.#previewUi.close(args.denops, args.context, args.uiParams);
        await this.#previewUi.removePreviewedBuffers(args.denops);
      }

      // NOTE: await may freeze UI
      const params = args.actionParams as RedrawParams;
      args.denops.dispatcher.redraw(args.options.name, {
        method: params?.method ?? "uiRefresh",
        searchItem: await this.#getItem(args.denops),
      });

      return ActionFlags.None;
    },
    toggleAllItems: async (args: {
      denops: Denops;
    }) => {
      if (this.#items.length === 0) {
        return Promise.resolve(ActionFlags.None);
      }

      this.#items.forEach((item) => {
        if (this.#selectedItems.has(item)) {
          this.#selectedItems.delete(item);
        } else {
          this.#selectedItems.add(item);
        }
      });

      await this.#updateSelectedItems(args.denops);

      return Promise.resolve(ActionFlags.Redraw);
    },
    toggleAutoAction: async (args: {
      denops: Denops;
      context: Context;
      uiParams: Params;
    }) => {
      // Toggle
      this.#enabledAutoAction = !this.#enabledAutoAction;

      const winid = await this.#winId({
        denops: args.denops,
        uiParams: args.uiParams,
      });
      await this.#setAutoAction(args.denops, args.uiParams, winid);

      await this.#doAutoAction(args.denops);
      if (!this.#enabledAutoAction) {
        await this.#previewUi.close(args.denops, args.context, args.uiParams);
      }

      return ActionFlags.None;
    },
    togglePreview: async (args: {
      denops: Denops;
      context: Context;
      options: DduOptions;
      uiParams: Params;
      actionParams: BaseParams;
      getPreviewer?: (
        denops: Denops,
        item: DduItem,
        actionParams: BaseParams,
        previewContext: PreviewContext,
      ) => Promise<Previewer | undefined>;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item || !args.getPreviewer) {
        return ActionFlags.None;
      }

      // Close if the target is the same as the previous one
      if (this.#previewUi.isAlreadyPreviewed(item)) {
        await this.#previewUi.close(args.denops, args.context, args.uiParams);
        return ActionFlags.None;
      }

      const uiParams = await this.#resolveParams(
        args.denops,
        args.options,
        args.uiParams,
        args.context,
      );

      return this.#previewUi.previewContents(
        args.denops,
        args.context,
        uiParams,
        args.actionParams,
        await this.#getBufnr(args.denops),
        item,
        args.getPreviewer,
      );
    },
    toggleSelectItem: async (args: {
      denops: Denops;
      options: DduOptions;
      uiParams: Params;
    }) => {
      const item = await this.#getItem(args.denops);
      if (!item) {
        return ActionFlags.None;
      }

      if (this.#selectedItems.has(item)) {
        this.#selectedItems.delete(item);
      } else {
        this.#selectedItems.add(item);
      }

      await this.#updateSelectedItems(args.denops);

      return ActionFlags.Redraw;
    },
    updateOptions: async (args: {
      denops: Denops;
      options: DduOptions;
      actionParams: BaseParams;
    }) => {
      await args.denops.dispatcher.updateOptions(
        args.options.name,
        args.actionParams,
      );
      return ActionFlags.None;
    },
  };

  override params(): Params {
    return {
      autoAction: {},
      autoResize: false,
      cursorPos: 0,
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
      floatingBorder: "none",
      floatingTitle: "",
      floatingTitlePos: "left",
      focus: true,
      highlights: {},
      ignoreEmpty: false,
      immediateAction: "",
      maxDisplayItems: 1000,
      maxHighlightItems: 100,
      maxWidth: 200,
      onPreview: (_) => {
        return Promise.resolve();
      },
      pathFilter: "",
      previewCol: 0,
      previewFocusable: true,
      previewFloating: false,
      previewFloatingBorder: "none",
      previewFloatingTitle: "",
      previewFloatingTitlePos: "left",
      previewFloatingZindex: 100,
      previewHeight: 10,
      previewMaxSize: 1000000,
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
      reversed: false,
      replaceCol: 0,
      split: "horizontal",
      splitDirection: "botright",
      startAutoAction: false,
      statusline: true,
      winCol: "(&columns - eval(uiParams.winWidth)) / 2",
      winHeight: 20,
      winRow: "&lines / 2 - 10",
      winWidth: "&columns / 2",
    };
  }

  async #close(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    cancel: boolean;
  }): Promise<void> {
    // NOTE: this.#close() may be multiple called by WinClosed autocmd.
    if (this.#closing) {
      return;
    }

    this.#closing = true;

    try {
      await this.#closeWindows(args);
    } finally {
      this.#closing = false;
    }
  }

  async #closeWindows(args: {
    denops: Denops;
    context: Context;
    options: DduOptions;
    uiParams: Params;
    cancel: boolean;
  }): Promise<void> {
    await this.#previewUi.close(args.denops, args.context, args.uiParams);
    await this.#previewUi.removePreviewedBuffers(args.denops);
    await args.denops.call("ddu#ui#ff#_reset_auto_action");

    // Move to the UI window.
    const bufnr = await this.#getBufnr(args.denops);
    if (!bufnr) {
      return;
    }

    if (
      args.uiParams.split === "floating" &&
      args.denops.meta.host !== "nvim" && this.#popupId > 0
    ) {
      // Focus to the previous window
      await fn.win_gotoid(args.denops, args.context.winId);

      // Close popup
      await args.denops.call("popup_close", this.#popupId);
      await args.denops.cmd("redraw!");
      this.#popupId = -1;
    } else {
      for (
        const winid of (await fn.win_findbuf(args.denops, bufnr) as number[])
      ) {
        if (winid <= 0) {
          continue;
        }

        if (
          (args.uiParams.split === "tab" &&
            await fn.tabpagenr(args.denops, "$") > 1) ||
          (args.uiParams.split !== "no" &&
            await fn.winnr(args.denops, "$") > 1)
        ) {
          await fn.win_gotoid(args.denops, winid);
          await args.denops.cmd("close!");

          // Focus to the previous window
          await fn.win_gotoid(args.denops, args.context.winId);
        } else {
          await fn.win_gotoid(args.denops, winid);

          await fn.setwinvar(args.denops, winid, "&winfixbuf", false);

          const prevName = await fn.bufname(args.denops, args.context.bufNr);
          await args.denops.cmd(
            prevName !== args.context.bufName || args.context.bufNr == bufnr
              ? "enew"
              : `buffer ${args.context.bufNr}`,
          );
        }
      }
    }

    // Restore mode
    if (this.#saveMode === "i") {
      if (!args.cancel && args.uiParams.replaceCol > 0) {
        const currentLine = await fn.getline(args.denops, ".");
        const replaceLine = currentLine.slice(
          0,
          args.uiParams.replaceCol - 1,
        ) + currentLine.slice(this.#saveCol - 1);
        await fn.setline(args.denops, ".", replaceLine);
        await fn.cursor(args.denops, 0, args.uiParams.replaceCol - 1);
      }

      const endCol = await fn.col(args.denops, ".");
      await fn.feedkeys(
        args.denops,
        args.uiParams.replaceCol > 1 || this.#saveCol > endCol ? "a" : "i",
        "ni",
      );
    } else if (this.#saveMode === ":") {
      const cmdline = (!args.cancel && args.uiParams.replaceCol > 0)
        ? this.#saveCmdline.slice(0, args.uiParams.replaceCol - 1) +
          this.#saveCmdline.slice(this.#saveCmdpos - 1)
        : this.#saveCmdline;
      const cmdpos = (!args.cancel && args.uiParams.replaceCol > 0)
        ? args.uiParams.replaceCol
        : this.#saveCmdpos;

      await args.denops.call(
        "ddu#ui#ff#_restore_cmdline",
        cmdline,
        cmdpos,
      );
    }

    if (
      this.#restcmd !== "" &&
      equal(this.#prevWinInfo, await getWinInfo(args.denops))
    ) {
      // Restore the layout.
      await args.denops.cmd(this.#restcmd);
      this.#restcmd = "";
      this.#prevWinInfo = null;
    }

    await args.denops.dispatcher.event(args.options.name, "close");
  }

  async #getItem(
    denops: Denops,
  ): Promise<DduItem | undefined> {
    const idx = await this.#getIndex(denops);
    return this.#items[idx];
  }

  #getSelectedItems(): DduItem[] {
    return this.#selectedItems.values();
  }

  async #getItems(denops: Denops): Promise<DduItem[]> {
    let items: DduItem[];
    if (this.#selectedItems.size() === 0) {
      const item = await this.#getItem(denops);
      if (!item) {
        return [];
      }

      items = [item];
    } else {
      items = this.#getSelectedItems();
    }

    return items.filter((item) => item);
  }

  async #collapseItemAction(denops: Denops, options: DduOptions) {
    let item = await this.#getItem(denops);
    if (!item || !item.treePath) {
      return ActionFlags.None;
    }

    if (!item.isTree || !item.__expanded) {
      // Use parent item instead.
      const treePath = typeof item.treePath === "string"
        ? item.treePath.split(pathsep)
        : item.treePath;
      const parentPath = treePath.slice(0, -1);

      const parent = this.#items.find(
        (itm) =>
          equal(
            parentPath,
            typeof itm.treePath === "string"
              ? itm.treePath.split(pathsep)
              : itm.treePath,
          ),
      );

      if (!parent?.treePath || !parent?.isTree || !parent?.__expanded) {
        return ActionFlags.None;
      }

      item = parent;
    }

    await denops.dispatcher.redrawTree(
      options.name,
      "collapse",
      [{ item }],
    );

    return ActionFlags.None;
  }

  async #initOptions(
    denops: Denops,
    options: DduOptions,
    uiParams: Params,
    bufnr: number,
  ): Promise<void> {
    const winid = await this.#winId({
      denops,
      uiParams,
    });
    const tabNr = await fn.tabpagenr(denops);
    const existsStatusColumn = await fn.exists(denops, "+statuscolumn");
    const existsWinFixBuf = await fn.exists(denops, "+winfixbuf");

    await batch(denops, async (denops: Denops) => {
      await fn.setbufvar(denops, bufnr, "ddu_ui_name", options.name);
      await fn.settabvar(denops, tabNr, "ddu_ui_name", options.name);

      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      if (existsStatusColumn) {
        await fn.setwinvar(denops, winid, "&statuscolumn", "");
      }
      if (
        existsWinFixBuf && uiParams.split !== "no" && uiParams.split !== "tab"
      ) {
        await fn.setwinvar(denops, winid, "&winfixbuf", true);
      }

      await fn.setbufvar(denops, bufnr, "&bufhidden", "hide");
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

  async #resolveParams(
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
      itemCount: this.#items.length,
      uiParams,
      ...context,
    };

    const params = Object.assign(uiParams);
    for (const name of uiParams.exprParams) {
      if (name in uiParams) {
        params[name] = await evalExprParam(
          denops,
          name,
          params[name],
          defaults[name],
          context,
        );
      } else {
        await printError(
          denops,
          `Invalid expr param: ${name}`,
        );
      }
    }

    return params;
  }

  async #getBufnr(
    denops: Denops,
  ): Promise<number> {
    return this.#bufferName.length === 0
      ? -1
      : await fn.bufnr(denops, this.#bufferName);
  }

  async #getIndex(
    denops: Denops,
  ): Promise<number> {
    const bufnr = await this.#getBufnr(denops);
    const cursorPos = await fn.getbufvar(
      denops,
      bufnr,
      "ddu_ui_ff_cursor_pos",
      [],
    ) as CursorPos;
    if (cursorPos.length === 0) {
      return -1;
    }

    const viewItem = this.#viewItems[cursorPos[1] - 1];
    return this.#items.findIndex(
      (item: DduItem) => equal(item, viewItem),
    );
  }

  #getItemIndex(viewItem: DduItem): number {
    return this.#items.findIndex(
      (item: DduItem) => equal(item, viewItem),
    );
  }

  async #doAutoAction(denops: Denops) {
    if (this.#enabledAutoAction) {
      await denops.call("ddu#ui#ff#_do_auto_action");
    }
  }

  async #setAutoAction(denops: Denops, uiParams: Params, winId: number) {
    const hasAutoAction = "name" in uiParams.autoAction &&
      this.#enabledAutoAction;

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

  async #cursor(
    denops: Denops,
    context: Context,
    pos: CursorPos,
  ): Promise<void> {
    if (pos.length !== 0) {
      await fn.cursor(denops, pos);
      await vars.b.set(
        denops,
        "ddu_ui_ff_cursor_pos",
        await fn.getcurpos(denops),
      );

      await this.#doAutoAction(denops);
    }

    const newPos = await fn.getcurpos(denops);
    if (pos[0]) {
      newPos[1] = pos[0];
    }
    if (pos[1]) {
      newPos[2] = pos[1];
    }

    await this.updateCursor({ denops, context });
  }

  async #updateSelectedItems(
    denops: Denops,
  ) {
    const setItems = new ObjectSet(this.#items);
    const toDelete = new ObjectSet<DduItem>();

    this.#selectedItems.forEach((item) => {
      if (!setItems.has(item)) {
        toDelete.add(item);
      }
    });

    toDelete.forEach((item) => this.#selectedItems.delete(item));

    await fn.setbufvar(
      denops,
      await this.#getBufnr(denops),
      "ddu_ui_selected_items",
      this.#getSelectedItems(),
    );
  }

  async #clearSavedCursor(denops: Denops) {
    const bufnr = await fn.bufnr(denops, this.#bufferName);
    if (bufnr > 0) {
      await fn.setbufvar(denops, bufnr, "ddu_ui_item", {});
    }
  }
}

async function initBuffer(
  denops: Denops,
  bufferName: string,
): Promise<number> {
  const bufnr = await fn.bufadd(denops, bufferName);
  await fn.setbufvar(denops, bufnr, "&modifiable", false);
  await fn.bufload(denops, bufnr);
  return bufnr;
}

async function evalExprParam(
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
    await printError(
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

async function getWinInfo(
  denops: Denops,
): Promise<WinInfo> {
  return {
    columns: await op.columns.getGlobal(denops),
    lines: await op.lines.getGlobal(denops),
    winid: await fn.win_getid(denops),
    tabpagebuflist: await fn.tabpagebuflist(denops) as number[],
  };
}

async function setStatusline(
  denops: Denops,
  context: Context,
  options: DduOptions,
  uiParams: Params,
  winid: number,
  floating: boolean,
  augroupName: string,
  items: DduItem[],
): Promise<void> {
  const statusState = {
    done: context.done,
    input: context.input,
    name: options.name,
    maxItems: context.maxItems,
  };
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
    (items.length !== context.maxItems
      ? ` ${items.length}/${context.maxItems}`
      : "");

  const linenr =
    "printf('%'.(('$'->line())->len()+2).'d/%d','.'->line(),'$'->line())";

  const input = `${context.input.length > 0 ? " " + context.input : ""}`;
  const async = `${
    context.done || await fn.mode(denops) == "c" ? "" : " [async]"
  }`;
  const footer = `${input}${async}`;

  if (floating || await op.laststatus.getGlobal(denops) === 0) {
    if (await vars.g.get(denops, "ddu#ui#ff#_save_title", "") === "") {
      await vars.g.set(
        denops,
        "ddu#ui#ff#_save_title",
        await op.titlestring.getGlobal(denops),
      );
    }

    await denops.cmd(
      `autocmd ${augroupName} WinClosed,BufLeave <buffer>` +
        " let &titlestring=g:ddu#ui#ff#_save_title",
    );

    const titleString = `${header} %{${linenr}}%*${footer}`;
    await vars.b.set(denops, "ddu_ui_ff_title", titleString);
    await op.titlestring.setGlobal(denops, titleString);

    await denops.cmd(
      `autocmd ${augroupName} WinEnter,BufEnter <buffer>` +
        " let &titlestring=b:->get('ddu_ui_ff_title', '')",
    );
  } else {
    await fn.setwinvar(
      denops,
      winid,
      "&statusline",
      `${header.replaceAll("%", "%%")} %#LineNR#%{${linenr}}%*${footer}`,
    );
  }
}

class ObjectSet<T extends object> {
  #items: T[] = [];

  constructor(initialItems?: T[]) {
    if (initialItems) {
      this.#items = [...initialItems];
    }
  }

  add(item: T): void {
    if (!this.has(item)) {
      this.#items.push(item);
    }
  }

  has(item: T): boolean {
    return this.#items.some((existingItem) => equal(existingItem, item));
  }

  clear(): void {
    this.#items = [];
  }

  size(): number {
    return this.#items.length;
  }

  delete(item: T): boolean {
    const index = this.#items.findIndex((existingItem) =>
      equal(existingItem, item)
    );
    if (index !== -1) {
      this.#items.splice(index, 1);
      return true;
    }
    return false;
  }

  values(): T[] {
    return [...this.#items];
  }

  forEach(callback: (item: T, index: number, array: T[]) => void): void {
    this.#items.forEach(callback);
  }
}
