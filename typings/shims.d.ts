/**
 * 最小环境声明：让工程在未安装 npm 类型包时也能通过类型检查。
 * 正式开发建议替换为官方类型包 miniprogram-api-typings（删除本文件并在 tsconfig types 中引用即可）。
 */
declare namespace WechatShim {
  interface PageBase {
    setData(data: Record<string, unknown>, callback?: () => void): void;
    createSelectorQuery(): any;
  }
}
declare const wx: any;
declare const App: (options: Record<string, any>) => void;
declare function Page<TData extends Record<string, any>, TCustom extends Record<string, any>>(
  options: TCustom & { data?: TData } & ThisType<TCustom & TData & WechatShim.PageBase>
): void;
declare const getApp: () => any;
declare const getCurrentPages: () => any[];
declare function setTimeout(cb: (...args: any[]) => void, ms?: number): number;
declare function clearTimeout(id: number): void;
