# Search Relevance Lab

搜索规则实验工作台：编辑查询改写（rewrite）、固定结果（pin）和降权/过滤（demote）规则，
用一组样例查询模拟实际作用，再对比草稿与已保存 revision。规则只在实验内生效，不直接控制线上搜索。

Run `npm install`, then `npm run dev` (API on :4174, Vite on :4173).

## 规则模型

- `rewrite`：`exact` 精确匹配或 `regex`（支持 `$1` 捕获组、`ignoreCase`），命中后替换查询并**再次进入匹配**。
- `pin`：把 `docId` 固定到 `position` 坑位；对最终改写后的查询求值。
- `demote`：`downweight`（分数乘 `factor`，只影响自然结果，固定结果免疫）或 `filter`（移除命中文档，**filter 覆盖 pin**，冲突写入决策链）。
- 匹配优先级：作用域具体性（具体作用域 > `*`）→ priority 降序 → exact 先于 regex → 编辑顺序（可用 ↑↓ 重排）。

## 服务端

- `POST /api/experiments/:id/simulate` 提交 `{rules, samples, draftHash}`：
  服务端用规范化 JSON 重算 SHA-256，与 `draftHash` 不符直接 `409 draft_hash_mismatch`，
  保证旧模拟结果不可能套到新草稿。
- 返回每个样例的 `chain` 决策链（每步带 ruleId，可回溯）、最终排序（pin/自然分列、文档级 ruleIds）、
  编译顺序，以及静态/运行时诊断：`unreachable_rule`（不可达/遮蔽）、`pin_slot_conflict`、
  `pin_filter_conflict`、`rewrite_cycle_potential`、`rewrite_loop`、`invalid_regex`、`unknown_doc` 等。
- `PUT /api/experiments/:id` 基于整数 `revision` 的乐观锁；并发保存只有一方成功，另一方拿到 `409` 与当前版本。
- 样例模拟相互隔离：单个样例失败只返回该样例 `ok:false`，不影响其他样例。

## 前端

- 规则卡片可编辑全部字段、启用/停用、↑↓ 重排；样例查询单独管理。
- 右侧「模拟」展示编译顺序、每个样例的查询流、结果（含产生该结果的规则徽章）和可展开决策链；
  点击任意规则徽章/诊断中的规则 id 可直接滚动定位到对应规则。
- 「对比」标签基于稳定 id + LCS 给出草稿与已保存 revision 的新增/删除/字段修改/重排。
- 顶部实时显示草稿哈希与已保存哈希；模拟请求绑定当前草稿哈希，编辑后旧结果立即失效，
  迟到的旧响应会被序号与双重哈希校验丢弃。保存冲突时保留草稿并可一键载入最新版本。

## 测试

`npm test` — 引擎测试（正则/精确优先级、作用域、重写再匹配、循环、pin 与 filter/downweight 冲突、
重排、校验、失败隔离、回溯）、API 测试（并发保存、哈希绑定、隔离失败）和 diff 测试。
