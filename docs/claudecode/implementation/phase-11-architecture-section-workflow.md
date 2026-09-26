# Phase 11 实现笔记 — Architecture / Section Workflow

Phase 11 directive §86 要求。基线：Phase 10（`104570e` feat + `a31d545` test）冻结。
本文记录 schema v8、Section workflow 状态/事件模型、active Section、Context v2/epoch v2、
select_section、prepare_proposal 生产面、Discovery→Architecture 桥、detail scope、
request-local aliases、Section 注册/checkpoint/completion、REOPEN_SECTION、依赖失效传播、
Evidence→Section review 桥、Detail→Synthesis 门、并发、恢复/压缩、以及 Phase 12 边界。

## 1. Schema v8（008-section-workflow）

`7 → 8`，继续复用 frozen migration/backup/rollback/fencing 通道（BEGIN IMMEDIATE、
registry、consistent backup、schema-7 writer fencing）。新表：

| 表 | 角色 |
| --- | --- |
| `section_workflow_events` | append-only workflow 历史（authority 的一半；与 immutable revision 共同构成 authority）|
| `section_workflow_states` | 物化投影：每 (run, section) 一行，携带 completion provenance |
| `planning_active_work` | 每 run 至多一行 active Section（PK run_id）|

DDL CHECK 直接编码 §8 不变量：`completed`/`needs_review` 行四项 completion 字段
（completed_revision / completed_proposal_id / completed_proposal_revision /
completion_commit_id）全部非空；`open` 行全部为空。触发器：events no_update/no_delete；
states 仅 no_delete（投影的 UPDATE 是正常路径）；`planning_active_work` 是普通可变
workflow 状态，无 immutability 触发器。索引：`idx_section_workflow_events_section`。

`SUPPORTED_SCHEMA_VERSION = 8`；`validateSchemaV8` 做结构检查（表/触发器/索引）加
目标化 LIMIT-1 数据检查（§69）：materialized status == last event 的 to_state；
每个 section identity 都有 workflow state；completed_revision 引用真实 section
revision；active work 指向当前 HEAD snapshot 中的 section。无 store-open 全历史
replay。

## 2. Workflow 状态与事件模型（§4/§7）

状态冻结为 `open / completed / needs_review`。事件冻结为
`REGISTERED / COMPLETED / REOPENED / DEPENDENCY_REVIEW_REQUIRED / EVIDENCE_REVIEW_REQUIRED`
（无 SET_STATUS/FORCE_COMPLETE/FORCE_VALID）。转换矩阵（`src/core/section-workflow.ts`）：
REGISTERED 仅 from=null；COMPLETED 自 open/needs_review（§44 再完成合法）；
REOPENED 自 completed/needs_review；两个 review 事件仅自 completed。
每次变化 = append event + UPDATE projection，同一事务（§7）；
`appendSectionWorkflowEventInTx` 校验 fromState 与物化状态一致，否则事务级失败关闭。
needs_review 保留先前 completion provenance（§6）；REOPENED 清空（§41）；
COMPLETED 写入新 provenance（§33）。

## 3. Migration backfill（§9）

迁移时对 `memory_artifacts WHERE kind='section'` 的每个 identity 写入
`REGISTERED`（reason `schema8_failclosed_initialization`）+ `open` 投影行。
stage/created_at/revision 数/contract 有无一概不作为完成证据（fail-closed）。
per-run event_seq 单调；event_id `registered:<sectionId>`。

## 4. Active Section（§10–§15）

`planning_active_work` 只存 (run_id, section_id)；exact revision 由 HEAD snapshot
解析，从不复制内容。`select_section`（MCP）只接受 `section_id`；run/workspace/
binding/expected revision 全部 server-derived（§12）。服务端栅栏（§13）：
run active → stage == detail（否则 SECTION_WORKFLOW_INVALID）→ section 存在于当前
HEAD（SECTION_NOT_FOUND）→ awaiting proposal scope 兼容（只允许相同 section scope，
否则 ACTIVE_PROPOSAL_SCOPE_CONFLICT）。重复选择同一 section 幂等、revision 不动；
换 section / 首次选择 run revision +1 恰一次（§14）——这使 awaiting proposal 的
baseRunRevision fencing 自动成立（§66 的并发 select 由 write 事务串行 +
`WHERE revision = ?` 守卫，败者 STALE_RUN_REVISION）。选择不要求依赖完成（§15，
可查看/推理），完成才检查。

## 5. Context 模型 v2 与 epoch v2（§16–§20/§50/§51）

`CONTEXT_MODEL_VERSION = 2`；v1 结构契约未被偷改，而是正式升级：
`activeScope`（sectionId + HEAD 解析 revision/title/workflowStatus）、
`sectionWorkflow.sections[]`（ref/title/status/completedRevision?/dependencies，
按 section id 确定序）、`activeDependencyContracts[]`（active section 的直接依赖
contract，绝不递归展开、绝不含全文设计）。`operations` 按 stage 能力增长
（prepare_proposal @ discovery/architecture/detail；select_section @ detail）。

epoch：`context-epoch:v2:<hex>`；输入 = Phase 8 五项 + active section + 确定性
workflow digest（sorted [{sectionId,status,completedRevision}] 的 sha256）。
select/complete/needs_review/reopen 都改变 epoch（§19）；Evidence 状态本身不在
epoch 输入里（§20/Phase 10 不变量保持）——只有当它产生真实 SECTION workflow fact
（bridge）时 epoch 才经由 digest 变化。

Recovery Capsule 升级为 `[Phase Plan Recovery v2]`，新增 required 级
`Section workflow:` 摘要与 active scope 行、required 级 `Dependency contracts`
段（compact contract 投影，无全文）；resume/compact 从 Store 完整重建（§52）。

## 6. select_section / prepare_proposal 生产面（§12/§21–§24/§53/§59–§61）

MCP 面共 10 工具（§74）。`prepare_proposal` 是第一个生产 model-facing prepare：

- 输入业务字段：`proposal_type / scope / title / summary / changes /
  required_evidence`；schema 拒绝 run_id/workspace/binding/base_run_revision/
  base_head/proposal_hash/force 等一切 authority（§22/§59/E19）。
- HostContext 签名 + businessInputHash + tool binding；要求 permission_mode=plan
  （hook 与 handler 双层，§59）；无 requiresUserInteraction —— Formal Approval
  仍只在 approve_proposal（§21/§61，不另造 approve_section）。
- 幂等（§60）：operationId = `prepare:<signed toolUseId>`；同 id 同输入回放同一
  proposal；同 id 不同输入 IDEMPOTENCY_CONFLICT。
- expectedRunRevision 取自 Store 当前值；写事务 `WHERE revision = ?` 保证并发
  漂移 → STALE_RUN_REVISION。

stage/scope 能力矩阵（§53）在 `gateTypeAndStage`：
discovery 仅 architecture design_checkpoint（原子进 Architecture，见下）；
architecture 仅 architecture scope；detail 允许 detail scope design_checkpoint
（DAG 创建）、section scope 的 checkpoint/section_completion/amendment(+reopen)、
architecture scope 的 amendment（不改 stage，§54）；synthesis+ 无 prepare。
scope 词表扩为 `architecture | detail | section`（§23），历史 V1/V2 scope 可读。

Discovery→Architecture 桥（§24/E20/E21）：合法的 discovery 首次 architecture
prepare 在同一事务内 `DISCOVERY_COMPLETE`（stage→architecture、revision+1）后
再 freeze，proposal 的 baseRunRevision 即新 revision；任何失败整体回滚，
不会出现"discovery 丢失但无 proposal"。audit_events 的 five-type CHECK 保持
frozen（§74 精神），桥/选择的事实由 planning_runs / planning_active_work 权威
承载。

## 7. Workflow ops：COMPLETE_SECTION / REOPEN_SECTION（§30–§31/§39–§40/§56–§58）

新增两个 canonical change op（进入 proposal hash，E30）：

- raw：`{op:'COMPLETE_SECTION'|'REOPEN_SECTION', sectionId, compactProjection}`。
  不携带 revision —— normalization 解析出精确 candidate revision：
  REOPEN target=base revision、result=candidate revision；COMPLETE target==result=
  candidate revision。持久化形态经 `parseNormalizedProposalChange` 再校验。
- type 约束：COMPLETE 仅 section_completion 且 scope=section 且等于 scoped
  section；REOPEN 仅 amendment 或 section_completion 且 scope=section（§39 与
  §40 的原子 reopen+amend+recomplete 组合的调和解释，见"偏差"节）。
- normalize 顺序固定（§40）：workflow facts 收集后在候选世界解析，canonical
  数组 = [memory mutations…, REOPEN…, COMPLETE…]（组内按 section id、REOPEN 先于
  COMPLETE）；模型数组顺序不改变事务语义（测试证明正反序 normalize 同构）。
  REOPEN 要求目标存在于 base（完成声明不能创造 identity）；COMPLETE 要求目标
  存在于候选世界。
- 每proposal 每 section 至多一个 REOPEN、一个 COMPLETE；simulate 对 workflow ops
  不写 revision，另在候选世界收敛后校验精确 revision 绑定。
- scope 纪律（§29/§53）：section-scope proposal 只能动 scoped section；
  detail scope 拒绝 workflow ops；architecture scope 拒绝一切 section 变更。
- request-local aliases（§27/§58/§82）：SET_SECTION_REVISION create 可带
  `localRef`；pre-pass 先为所有 alias 分配 server id（SEC-N），依赖边与
  COMPLETE/REOPEN 的 sectionId 经 alias map 解析；alias 不持久化、不入
  canonical identity（canonical 只含 server id，测试 §58 直接断言）。
- completed Section 的普通 SET 被 prepare 拒绝（SECTION_WORKFLOW_INVALID），
  必须同 proposal 显式 REOPEN（§38/E41）。DELETE/retire 无此能力：未知 op 在
  normalize 即 PROPOSAL_INVALID，绝不静默 drop（§57）。

## 8. Section 注册 / checkpoint / completion（§28–§35）

引擎（plan-commit-engine）在 PlanCommit 事务内的 workflow 块，顺序固定：

1. 注册（§28/E27）：本次 commit 新建的 section identity 同事务写 REGISTERED+open。
2. REOPENED（§39/§41）：completed/needs_review → open，provenance 清空；
   active section 若即目标则保持 active；不动 run revision/stage。
3. 依赖 review 传播（§42/E43）：对每个 reopened id，在新 HEAD 的 section DAG 上
   BFS 收集下游 completed sections → needs_review（DEPENDENCY_REVIEW_REQUIRED），
   保留其 provenance；本 commit 内将要 complete 的 section 被排除；immutable
   revisions/HEAD/Decision/Architecture/stage 一概不动。
4. COMPLETED（§30/§33）：open/needs_review → completed，绑定
   completedRevision=candidate revision 与 (proposal, revision, commitId)。
5. Active 清空 + Detail→Synthesis（§34–§36/E35–E38）：completion 必然命中
   active section（§32 门），清 active work；若 HEAD 上每个 section 都在其
   exact revision 完成（>0 且无 needs_review），同一 bump 内 DETAIL_COMPLETE →
   synthesis；run revision 恰 +1 一次。空 section 集永不满足（§36，guard
   `assertDetailCompletionAllowedInTx`）。

§32 完成前置门（commit 事务内、候选 snapshot 物化后执行）：stage=detail；
target==active（SECTION_NOT_ACTIVE）；状态非 completed@同 revision
（SECTION_ALREADY_COMPLETED；needs_review 可直接再完成 §44）；candidate 含
target 的精确 revision；有 frozen SectionContract；全部直接依赖存在且在候选
revision 上 completed（SECTION_DEPENDENCY_INCOMPLETE）；无 target-scoped
blocking question（open+blocking+scope==sectionId 的 typed 字段）与
target-relevant hard conflict（refs 含 section identity）——不做 substring
启发式；critical required Evidence 由 step 12.5 的 Phase 10 门承担（E33）。
checkpoint（§29/E28）：design_checkpoint 提交后 status 仍 open、active 不变、
run revision 不变。

## 9. 依赖失效与 Evidence→Section review 桥（§42–§49/E43–E49）

- 下游 review 不自动恢复（§43）：A 重新完成后 B/C 保持 needs_review，必须各自
  新的 section_completion Proposal + 正式 Approval，即使内容零变化；needs_review
  可用 changes=[COMPLETE_SECTION] 在同一 exact revision 上再完成（§44/E45）。
- Phase 10 不变量保持：Evidence 永不自动 reopen 设计；只有"真实 basis 变化"
  事件触发 review：SOURCE_CHANGED / REPLACED / INVALIDATED / 由它们传播的真实
  UPSTREAM_CHANGED（§46/E48：FILE_CHANGED_HINT 单独不触发，false-positive
  hint 不迫使用户重新审批）。
- 影响来源是精确 provenance（§47）：SQL 直接 join
  `section_workflow_states(completed_*) × proposal_evidence_refs ×
  evidence_revisions(criticality='critical')`，exact (evidence_id, revision)
  匹配；不扫描 claim 文本、不读对话、不猜。supporting/informational 永不触发。
- 桥接点：`evaluateCriticalEvidenceGateInTx`（commit recheck 发现 SOURCE_CHANGED
  时同事务触发；§37 follow-up 事务重放发现并持久化）、revalidate 的
  check-SOURCE_CHANGED / assess-contradicted-INVALIDATED /
  confirmed-REPLACED 路径（与 evidence 事件同事务；EV@N+1 fresh 绝不自动
  re-complete，§49/E49）。递归下游与 §42 同一 BFS（DEPENDENCY_REVIEW_REQUIRED）。

## 10. 并发（§66–§68/E59/E60）

- select 竞态：write 事务串行 + `UPDATE ... WHERE revision = ?`；测试用 stale
  expected revision 注入失败者（STALE_RUN_REVISION），最终 revision 恰 N+1。
- completion 并发：Phase 6 幂等 —— 同一 frozen proposal 的重放返回同一
  PlanCommit（一个 approval/commit/workflow 转换，不重复 +2）。
- completion vs reopen 竞态：HEAD/base、run revision、one-awaiting、proposal
  hash 全部照常栅栏；不可能出现"workflow completed 但 HEAD 含未批准的
  reopened revision"（同一事务强一致）。

## 11. Detail→Synthesis 门与 Architecture amendment（§35–§36/§54–§55/E37–E39）

最后一段的 section completion commit 中，若 HEAD 全部 section 在 exact revision
完成且无 needs_review，同一事务 DETAIL_COMPLETE → synthesis（一次 bump）；
needs_review（E40）或空集（E38）阻断。Detail 中的 architecture amendment 走
完整 Proposal/Approval/PlanCommit + critical Evidence 门，但不回退 stage（§54）；
Core 不做语义影响猜测，不静默标 needs_review（§55/E52）——结构化依赖变化
（reopen/bridge）才传播。

## 12. 迁移 / fencing / 回滚（§70–§72/E1/E57/E58）

真实 schema-7 fixture（constraint + section artifact）迁移后旧行原样、legacy
section → open + REGISTERED、active work 表空、history [1..8]、
`phase-plan-pre-schema-7-8-*` 备份有效；注入 failing 008 回滚出干净 schema-7
（无半张表）；schema-7 writer 在 v8 store 上 STORE_SCHEMA_TOO_NEW 零写入；
v8 结构校验器对"投影行与 last event 不一致"报 invalid。

## 13. 偏差与调和解释（§89.36 摘要）

1. **REOPEN_SECTION 的 type 集合**：§39 说"只允许 type=amendment scope=section"，
   §40 又要求 REOPEN+SET+甚至 COMPLETE 能在一个 proposal 里原子完成。实现取
   REOPEN ∈ {amendment, section_completion} @ section scope；三连组合落在
   section_completion（COMPLETE 只在此 type 合法）。这保持 §39 的本意
   （reopen 必须显式 Proposal-authorized）并满足 §40 的原子性。
2. **audit_events 未扩展**：ACTIVE_SECTION_SELECTED / DISCOVERY_COMPLETE 最初以
   raw insert 写审计，撞上 five-type CHECK 后按 §74 精神撤除 —— 选择/桥的
   权威事实由 planning_active_work、planning_runs.revision、workflow events
   承载；PLAN_COMMITTED 的 payload 新增 `sectionWorkflow` 摘要。
3. **canonical workflow-op 顺序**：§40"推荐 REOPEN → design → COMPLETE"落为
   canonical 数组 [memory mutations, REOPEN, COMPLETE]（引擎按
   register→reopen→propagate→complete 的固定顺序应用，最终状态与推荐序一致）；
   测试断言模型正反序 normalize 同构。
4. **§57 删除语义**：DELETE_SECTION 不存在于词表，尝试在 normalize 得
   PROPOSAL_INVALID（unknown op）；不发明 retire 语义，不从 snapshot 静默 drop。

## 14. Phase 12 边界（未实现，词表已被结构拒绝）

SynthesisInput / SynthesisManifest / Validator / SemanticValidation /
FinalizationGate / FinalPlan / Handoff：无表、无工具、无 stage 推进
（synthesis 之后无 prepare、无 request_finalization/handoff/takeover_run/
abort_run 工具，E56）。run 的 lifecycle=completed 路径仍冻结待 Finalization 阶段。
