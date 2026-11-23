# Parser vendor 来源

`core.cjs`、`backend.cjs`、`platform.cjs` 最初原样复制自本机 Hermes 技能 `scriptcat-userscript-development` 的 `scripts/tmall-sku-batch/`。来源技能版本 1.12.0，技能元信息声明 MIT。本站在 `backend.cjs` 额外导出原有的单商品解析器，并在 `core.cjs` 用整数分解析、比较和格式化详情金额。

它们负责详情 SSR JSON、SKU 精确价格/规格、后台价格匹配以及淘宝/天猫 API 与详情来源配对。程序仅依赖本目录相对路径；运行或部署不需要本机技能目录。传输、签名、Cookie jar、身份核验、两套列表分页和逐商品提交均由相邻 TypeScript 模块负责。

`client.ts` 独立验证分页覆盖、实际返回 pageSize、平台证据与跨页重复，随后对需要采集的商品单独解析 SKU。后台和详情共用保留金额数字原始字面量的 JSON 解析函数，由 `core.cjs` 的 `parseHtml` 调用方传入该函数。

金额统一输出十进制元字符串：后台 `skuList[].price` 已是元；详情 `priceMoney` 是分，由解析器按标签及 priceText 交叉校验转换。汇总 SKU 0 不当成独立 SKU；无法精确确认的价格留空。
