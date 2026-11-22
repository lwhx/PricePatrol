# Parser vendor 来源

`core.cjs`、`backend.cjs`、`platform.cjs` 原样复制自本机 Hermes 技能 `scriptcat-userscript-development` 的 `scripts/tmall-sku-batch/`，复制时未改动源文件字节。来源技能版本 1.12.0，技能元信息声明 MIT。

它们负责详情 SSR JSON、SKU 精确价格/规格、后台价格匹配以及淘宝/天猫 API 与详情来源配对。程序仅依赖本目录相对路径；运行或部署不需要本机技能目录。传输、签名、Cookie jar、身份核验、两套列表分页和逐商品提交均由相邻 TypeScript 模块负责。

上游解析器的 `parsePage` 只接受非零商品总数。`client.ts` 在调用它前独立验证空店/分页覆盖、实际返回 pageSize、平台证据与跨页重复，合法总数为 0 的空列表不会经过其非零分页断言。

金额统一输出十进制元字符串：后台 `skuList[].price` 已是元；详情 `priceMoney` 是分，由解析器按标签及 priceText 交叉校验转换。汇总 SKU 0 不当成独立 SKU；无法精确确认的价格留空。
