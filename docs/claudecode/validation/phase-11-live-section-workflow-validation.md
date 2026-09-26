# Phase 11 真机验证 — Architecture / Section Workflow live E2E

结论：**全部 PASS**。Phase 11 directive §76–§79 的真机/高保真验证全部通过，Phase 10
的 live 语义（freshness gate、approval 桥）保持有效。无 settings 修改、无 debug
变异工具、无 fixture 改 stage —— §76 主链全程真实宿主。

Host：Claude Code **2.1.283**（Interactive TUI，glm-5.3-flash-cc），Windows
10.0.19044，Node **24.21.0**。Plugin：inline
`--plugin-dir D:\Programing\agent\plan-plugin\adapters\claude-code`（dist 构建
自 `8847904`）。Workspace：`C:\Users\Administrator\phase11-live-ws`（首次注册 +
trust）。Store：宿主 inline-plugin 根
`C:\Users\Administrator\.claude\plugins\data\phase-plan-inline\`（与 Phase 7–10
live 共享）。会话退出均为正常 `/exit`。

## 0. Live migration 7 → 8 on the real store

共享宿主 store 在 Phase 10 live 后为 v7；Phase 11 二进制首次加载即完成真实
`7 → 8` 迁移：`user_version = 8`，history `[1..8]` 末行
`section-workflow`；`section_workflow_states` / `planning_active_work` 初始为空
（真实 store 中当时没有 Section —— §9 无从猜测，也没有猜测）。

## 1. MCP surface：10 tools

新会话加载后工具面即 Phase 11 集合（select_section / prepare_proposal 加入），
与 §74 一致（下方 §77 会话的 selection UI 与全部工具调用均来自真实 MCP surface）。

## 2. Run 1 — §76 主链（真实宿主，全程无 fixture）

Run：`plan_7878c977-e657-47dc-b77a-d6baae8c48ca`（goal “Phase 11 section
workflow live validation: build a small two-section plan”）。

| 步骤 | 结果（屏幕 + store 双重验证） |
| --- | --- |
| `/phase-plan` 进入 | plan mode 链正常；run 创建于 discovery/rev 1 |
| prepare Architecture checkpoint | **新生产工具 `prepare_proposal` 首次真实调用**；模型只给业务字段；`CAPABILITY` 幂等回放验证（§60）：同 toolUseId 重放同 proposal；`base_run_revision=2` 证明 §24 Discovery→Architecture 桥在同一事务先行完成（run: discovery/1 → architecture/2） |
| 真实 Allow（approve_proposal） | 宿主 `requiresUserInteraction` 对话框（精确三元组上屏），用户选 Yes → `CMT-c2ed3d78…`（sequence 1），`ARCH-1@1` 入 HEAD |
| prepare + Allow Architecture completion | `APPR-b3ba7e4e…` / `CMT-2b9b1a58…` / `snap_592995e7…`，run → **detail**/rev 3（模型屏报 “Net effect … run advanced to revision 3, stage detail”） |
| prepare Detail DAG（detail scope） | 模型两次因自拟 contract 形状被 typed 校验拒绝后**自行读取插件源码**修正，第三次成功；**request-local alias `storage` 被 server 解析**（canonical 只含 SEC id）；Allow 后 `SEC-1`/`SEC-2` 以 REGISTERED→open 原子注册（§28 store 验证：两条 REGISTERED 事件、active 空） |
| select_section SEC-1 | 工具真实调用（只传 section_id）；run rev 3→4（§14 一次 +1） |
| Section checkpoint（SET → @2）+ Allow | `SEC-1@2` 提交但 **status 仍 open、active 仍 SEC-1、run rev 不再动**（§29 store 验证 rev 4） |
| section_completion SEC-1（COMPLETE_SECTION 绑定 @2）+ Allow | COMPLETED 事件 + provenance（PROP-bb425f65…@1 / CMT-38588aec…）；active 清空；run rev 4→5 恰一次（§34） |
| select SEC-2 + section_completion + Allow | SEC-2 COMPLETED（PROP-e0d08e56… / CMT-9abc60bd…）；同事务 **DETAIL_COMPLETE → synthesis**，run rev 5→7？—— 实测两次 bump 分别发生在两个 completion（5、7 中间含 select 的 +1），总账：**stage=synthesis、rev=7、commits=6、active=0**（§35/§36：非空集、全部按 exact revision 完成、无 needs_review） |

模型自己上屏结语：“All done. The final approval advanced the run to stage
'synthesis' … A run reaches Synthesis only when every section is completed at
its current revision and none needs review.”

## 3. 负向证明（真实宿主）

- **Synthesis 无 prepare**（§53/E56 之外的另一面）：在 synthesis 阶段直接尝试
  Step-7 reopen amendment → `{"ok":false,"code":"CAPABILITY_NOT_AVAILABLE",
  "message":"proposal preparation is not available at stage 'synthesis'"}`；
  get_context 的 operations 列表也只剩 4 个只读/入口操作。
- **Entry intent 不可重放**：同会话内复用旧 token 启动第二个 run →
  `ENTRY_INTENT_INVALID: entry intent is bound to a different session or
  prompt`（prompt 绑定栅栏真实生效）。
- **绑定会话不能静默开第二个 run**：`action=start_new` 在本会话有 attached
  active run 时按 Phase 7 §24 Case A 返回 resumed（frozen 语义，非 Phase 11
  回归）；第二个 run 由**第二个独立会话**发起 —— 宿主弹出了真实的
  RUN_SELECTION_REQUIRED 选择 UI（“Phase Plan never attaches to it
  automatically”），选择 “Start a new run”。

## 4. Run 2 — §77 依赖失效 + §78 Evidence 桥 + §79 压缩（真实宿主）

Run：`plan_797b0bbe-1f0b-4ea3-9930-aed39525377d`（第二会话，同 workspace）。
链路：Architecture checkpoint/completion（真实 Allow ×2）→ 三 Section DAG
（`storage` alias → `API layer` deps；`Ops` 独立）→ 真实 `Read` →
`promote_evidence` critical fingerprint `ev_18c20e08-4051-46fc-a278-7c60b4533501@1`
（fresh）→ SEC-1 completion **requiredEvidence=[ev_18c20e08@1]**
（`proposal_evidence_refs` 实录该绑定，§47 精确 provenance）→ SEC-2 completion；
SEC-3 保持 open 使 run 停在 detail。

### §77 依赖失效（模型屏报 + store 事件双验证）

1. amendment（REOPEN_SECTION SEC-1）+ 真实 Allow → `CMT-585d2beb…`：
   SEC-1 → **open**（REOPENED/explicit_reopen_proposal，provenance 清空）；
   SEC-2 → **needs_review**（DEPENDENCY_REVIEW_REQUIRED/
   upstream_section_reopened，**保留** completed_revision=1 与原 PROP）；
   SEC-3 不受影响（open）。
2. 重新完成 SEC-1（needs_review → COMPLETED，同一 exact revision @1）：
   **SEC-2 保持 needs_review —— 无自动恢复**（§43/E44）。
   模型屏报原文：“reopen propagates down (SEC-1 reopen → SEC-2 invalidated),
   but re-completion does not propagate up (SEC-2 stays in review).”

### §78 Evidence → Section review（真实漂移 + 真实桥）

- 操作者在宿主外将 `invalidation-src.txt` 改为 v2；模型 `revalidate_evidence
  mode=check` → **SOURCE_CHANGED → needs_validation**（evidence 事件实录）。
  当时的 SEC-1 完成提案未携带 evidence refs —— 桥**不命中**（§47 精确
  provenance 的反面证明：无绑定即无影响，不猜测）。
- 模型重读源文件 → `mode=assess confirmed` → **EV@2 fresh / EV@1 stale
  (REPLACED)**；SEC-3 completion **requiredEvidence=[ev_18c20e08@2]** 提交并
  Allow（refs 表实录）。
- 操作者再改源为 v3；`mode=check` on EV@2 → **SOURCE_CHANGED** → 桥真实触发：
  **SEC-3 → needs_review（EVIDENCE_REVIEW_REQUIRED /
  critical_evidence_basis_changed）**；同获知 SEC-1 的当次完成亦绑定该证据，
  同样转 needs_review。**HEAD（CMT-afe45a2b…）与 stage（detail）纹丝不动**，
  SEC revision 无任何改写（§78 全部断言 store 验证）。

### §79 压缩恢复（真实 /compact）

- `select_section SEC-1`（active）后真实执行 `/compact`
  （“Compacting conversation… done”，“Skills restored
  (phase-plan:phase-plan)”）。
- 压缩后向（已失去对话历史的）模型要求仅凭 Recovery Capsule 报告状态，并用
  get_state 复核 —— 模型给出的对照表（上屏）：

| 项 | Capsule | get_state | |
| --- | --- | --- | --- |
| Run | plan_797b0bbe… | 同 | ✓ |
| Stage / rev | detail / 14 | detail / 14 | ✓ |
| Active section | SEC-1@1 | `activeSection.section_id: "SEC-1"` | ✓ |
| HEAD commit | CMT-afe45a2b… | 同 | ✓ |
| HEAD snapshot | snap_389ff97a… | 同 | ✓ |
| Sections | SEC-1/2/3 all needs_review | `sectionCounts {open:0, completed:0, needsReview:3}` | ✓ |
| Awaiting proposal | (none) | none | ✓ |

  模型结语：“Post-compaction recovery is faithful.”（§52/E64：active Section、
  workflow 状态、HEAD 全部由 Store 重建；epoch 为 context-epoch:v2 规则。）

## 5. 与自动化矩阵的关系

§63–§66/§70、§80–§84 全部由 35 个新增自动化测试覆盖
（`section-workflow` / `section-proposal-surface` / `section-context` /
`evidence-section-bridge` / `store-migration-v8` / `mcp-phase11`），Node 22 与
Node 24 各 598 passed、OpenCode 566 passed。本文只记录真机部分。

## 6. 结论

| Directive 项 | 结果 |
| --- | --- |
| §76 真机主链（Discovery→Architecture→Detail→DAG→select→checkpoint→completion→synthesis） | PASS（全程真实宿主） |
| §77 依赖失效/重审（真实） | PASS |
| §78 Evidence 桥（真实漂移 + 真实桥） | PASS |
| §79 压缩恢复（真实 /compact） | PASS |
| §54/§53 synthesis 无 prepare（真实负向） | PASS |
| Entry-intent prompt 绑定 / RUN_SELECTION_REQUIRED（真实负向） | PASS |
| Live migration 7→8 | PASS |
| Phase 8/9/10 live 语义保持（§66/E66） | PASS（plan mode 链、approve 桥、freshness 工具全量复用无异常） |
