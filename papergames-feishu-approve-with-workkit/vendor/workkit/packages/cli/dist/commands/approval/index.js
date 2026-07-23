import { approveOrRejectFromSnapshot, buildApprovalAiOverrides, buildApprovalSnapshot, buildSummaryContext, approvalCardRenderInput, createApprovalCardState, createBeisenAdapter, createFeishuAdapter, fetchOaWorkflowDetailRaw, createOaAdapter, handleApprovalCardEvent, handleApprovalTextAction, listApprovalInbox, loadApprovalSnapshot, loadApprovalHistory, markApprovalCardEventProcessing, saveApprovalSnapshot, } from "@workkit/approval";
import { renderApprovalTableSummaryCard, renderCollapseInboxCard, renderInboxListCard, renderSplitCollapseInboxCards, } from "@workkit/card-kit";
import { errorEnvelope, okEnvelope, resolveIdentity, WorkkitError, WorkkitErrorCode, } from "@workkit/core";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringFlag } from "../../args.js";
const TABLE_SUMMARY_BODY_MAX_ELEMENTS = 160;
const TABLE_SUMMARY_PANEL_MAX_ELEMENTS = 150;
const TABLE_SUMMARY_MAX_ITEMS = 5;
export async function runApprovalCommand(args) {
    const [resource, action, subAction] = args.positionals.slice(1);
    if (resource === "sources" && action === "list") {
        return okEnvelope({
            sources: [
                { id: "feishu", label: "飞书审批", actionSupported: true },
                { id: "oa", label: "OA", actionSupported: false },
                { id: "beisen", label: "北森", actionSupported: false },
            ],
        }, {
            requestId: randomUUID(),
            sources: ["feishu", "oa", "beisen"],
        });
    }
    if (resource === "inbox" && action === "list") {
        const identity = resolveIdentityFromFlags(args);
        const keyword = stringFlag(args.flags, "description") ?? stringFlag(args.flags, "search");
        const applicant = stringFlag(args.flags, "applicant") ?? stringFlag(args.flags, "initiator");
        const process = stringFlag(args.flags, "process") ?? stringFlag(args.flags, "flow");
        const arrivedAfter = stringFlag(args.flags, "arrived-after") ?? stringFlag(args.flags, "arrival-after");
        const startedAfter = stringFlag(args.flags, "started-after") ?? stringFlag(args.flags, "start-after");
        const startedBefore = stringFlag(args.flags, "started-before") ?? stringFlag(args.flags, "start-before");
        const startedOn = stringFlag(args.flags, "started-on") ?? stringFlag(args.flags, "start-on");
        const sources = parseSources(stringFlag(args.flags, "sources"));
        const pageSize = numberFlag(args.flags, "page-size");
        const query = {
            view: stringFlag(args.flags, "view") ?? "pending_all",
            limit: numberFlag(args.flags, "limit") ?? 50,
            ...(keyword ? { keyword } : {}),
            ...(applicant ? { applicant } : {}),
            ...(process ? { process } : {}),
            ...(arrivedAfter ? { arrivedAfter } : {}),
            ...(startedAfter ? { startedAfter } : {}),
            ...(startedBefore ? { startedBefore } : {}),
            ...(startedOn ? { startedOn } : {}),
            fetchOaDetails: !booleanFlag(args.flags, "no-fetch-oa-details"),
            ...(sources ? { sources } : {}),
        };
        const larkProfile = stringFlag(args.flags, "lark-profile");
        const feishuOptions = {
            ...(larkProfile ? { profileName: larkProfile } : {}),
            ...(pageSize ? { pageSize } : {}),
            enrichArrival: !booleanFlag(args.flags, "no-enrich-arrival"),
        };
        return listApprovalInbox(identity, query, [
            createFeishuAdapter(feishuOptions),
            createOaAdapter(),
            createBeisenAdapter(),
        ]);
    }
    if (resource === "summary-context") {
        const identity = resolveIdentityFromFlags(args);
        const keyword = stringFlag(args.flags, "description") ?? stringFlag(args.flags, "search") ?? "";
        const applicant = stringFlag(args.flags, "applicant") ?? stringFlag(args.flags, "initiator");
        const process = stringFlag(args.flags, "process") ?? stringFlag(args.flags, "flow");
        const arrivedAfter = stringFlag(args.flags, "arrived-after") ?? stringFlag(args.flags, "arrival-after");
        const startedAfter = stringFlag(args.flags, "started-after") ?? stringFlag(args.flags, "start-after");
        const startedBefore = stringFlag(args.flags, "started-before") ?? stringFlag(args.flags, "start-before");
        const startedOn = stringFlag(args.flags, "started-on") ?? stringFlag(args.flags, "start-on");
        const sources = parseSources(stringFlag(args.flags, "sources")) ?? ["feishu"];
        const envelope = await listApprovalInbox(identity, {
            view: "pending_all",
            limit: numberFlag(args.flags, "limit") ?? 100,
            ...(keyword ? { keyword } : {}),
            ...(applicant ? { applicant } : {}),
            ...(process ? { process } : {}),
            ...(arrivedAfter ? { arrivedAfter } : {}),
            ...(startedAfter ? { startedAfter } : {}),
            ...(startedBefore ? { startedBefore } : {}),
            ...(startedOn ? { startedOn } : {}),
            fetchOaDetails: !booleanFlag(args.flags, "no-fetch-oa-details"),
            sources,
        }, [
            createFeishuAdapter({
                ...feishuProfileOptions(args),
                enrichArrival: !booleanFlag(args.flags, "no-enrich-arrival"),
            }),
            createOaAdapter(),
            createBeisenAdapter(),
        ]);
        if (!envelope.ok) {
            return envelope;
        }
        return okEnvelope(buildSummaryContext(envelope.data.legacyGroups, keyword), envelope.meta, envelope.warnings);
    }
    if (resource === "ai-overrides") {
        const inputPath = stringFlag(args.flags, "input");
        if (!inputPath) {
            throw new WorkkitError(WorkkitErrorCode.InvalidInput, "--input is required for approval ai-overrides.");
        }
        const payload = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
        const startedAt = Date.now();
        const options = {};
        const batchSize = numberFlag(args.flags, "batch-size");
        const concurrency = numberFlag(args.flags, "concurrency");
        const maxTokens = numberFlag(args.flags, "max-tokens");
        if (batchSize !== undefined) {
            options.batchSize = batchSize;
        }
        if (concurrency !== undefined) {
            options.concurrency = concurrency;
        }
        if (maxTokens !== undefined) {
            options.maxTokens = maxTokens;
        }
        const result = await buildApprovalAiOverrides(payload, options);
        return okEnvelope({ overrides: result.overrides }, { requestId: randomUUID(), elapsedMs: Date.now() - startedAt }, result.warnings);
    }
    if (resource === "oa-detail" && action === "get") {
        const requestId = stringFlag(args.flags, "request-id") ?? stringFlag(args.flags, "requestid");
        if (!requestId) {
            throw new WorkkitError(WorkkitErrorCode.InvalidInput, "--request-id is required for approval oa-detail get.");
        }
        return okEnvelope(await fetchOaWorkflowDetailRaw(requestId), { requestId: randomUUID() });
    }
    if (resource === "history") {
        const kind = (action || "card");
        const queryDescription = stringFlag(args.flags, "description") ?? stringFlag(args.flags, "search");
        return okEnvelope({
            entries: loadApprovalHistory(kind, {
                limit: numberFlag(args.flags, "limit") ?? 20,
                ...(queryDescription ? { queryDescription } : {}),
            }),
        }, { requestId: randomUUID() });
    }
    if (resource === "snapshot" && action === "save") {
        const inputPath = stringFlag(args.flags, "input");
        if (!inputPath) {
            throw new WorkkitError(WorkkitErrorCode.InvalidInput, "--input is required for snapshot save.");
        }
        const envelope = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
        const cardShards = parseJsonFlag(args.flags, "card-shards-json");
        const expiresInSeconds = numberFlag(args.flags, "expires-in-seconds");
        const snapshot = saveApprovalSnapshot(buildApprovalSnapshot({
            approvalList: envelope.data?.legacyGroups ?? [],
            receiveId: stringFlag(args.flags, "receive-id") ?? "",
            receiveIdType: stringFlag(args.flags, "receive-id-type") ?? "",
            messageId: stringFlag(args.flags, "message-id") ?? "",
            cardToken: stringFlag(args.flags, "card-token") ?? "",
            queryDescription: stringFlag(args.flags, "description") ?? stringFlag(args.flags, "search") ?? "",
            ownerOpenId: stringFlag(args.flags, "owner-open-id") ?? "",
            queryNonce: stringFlag(args.flags, "query-nonce") ?? "",
            expiresAt: stringFlag(args.flags, "expires-at") ?? "",
            ...(expiresInSeconds ? { expiresInSeconds } : {}),
            cardStyle: approvalCardStyle(args.flags),
            aiOverrides: parseJsonFlag(args.flags, "describe-overrides-json"),
            ...(Array.isArray(cardShards)
                ? { cardShards: cardShards.filter(isRecord) }
                : {}),
        }));
        return okEnvelope(snapshot, { requestId: randomUUID() });
    }
    if (resource === "snapshot" && action === "get") {
        return okEnvelope(loadApprovalSnapshot({
            ...(stringFlag(args.flags, "receive-id")
                ? { receiveId: stringFlag(args.flags, "receive-id") }
                : {}),
            ...(stringFlag(args.flags, "receive-id-type")
                ? { receiveIdType: stringFlag(args.flags, "receive-id-type") }
                : {}),
            ...(stringFlag(args.flags, "snapshot")
                ? { snapshotPath: stringFlag(args.flags, "snapshot") }
                : {}),
        }) ?? {}, { requestId: randomUUID() });
    }
    if (resource === "card" && action === "render" && subAction === "inbox") {
        const inputPath = stringFlag(args.flags, "input");
        if (!inputPath) {
            throw new WorkkitError(WorkkitErrorCode.InvalidInput, "--input is required for card render inbox.");
        }
        const envelope = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
        const style = approvalCardStyle(args.flags);
        if (style === "simple") {
            return renderInboxListCard({
                items: envelope.data?.items ?? [],
                warnings: envelope.warnings ?? [],
            });
        }
        const input = {
            groups: envelope.data?.legacyGroups ?? [],
            queryDescription: stringFlag(args.flags, "description") ?? stringFlag(args.flags, "search") ?? "",
            warnings: envelope.warnings ?? [],
            aiOverrides: parseJsonFlag(args.flags, "describe-overrides-json"),
            actionStates: envelope.data?.actionResults ?? {},
            fieldResolution: envelope.data?.fieldResolution ?? [],
            queryNonce: stringFlag(args.flags, "query-nonce") ?? "",
            expiresAt: stringFlag(args.flags, "expires-at") ?? "",
        };
        const renderCard = rendererForCardStyle(style);
        if (booleanFlag(args.flags, "split")) {
            const bodyMaxElements = numberFlag(args.flags, "body-max-elements") ??
                (style === "table-summary" ? TABLE_SUMMARY_BODY_MAX_ELEMENTS : undefined);
            const panelMaxElements = numberFlag(args.flags, "panel-max-elements") ??
                (style === "table-summary" ? TABLE_SUMMARY_PANEL_MAX_ELEMENTS : undefined);
            const maxRequestBytes = numberFlag(args.flags, "max-request-bytes");
            const maxItemsPerGroup = numberFlag(args.flags, "max-items-per-group") ??
                (style === "table-summary" ? TABLE_SUMMARY_MAX_ITEMS : undefined);
            const maxItemsPerCard = numberFlag(args.flags, "max-items-per-card") ?? maxItemsPerGroup;
            const shards = renderSplitCollapseInboxCards(input, {
                receiveId: stringFlag(args.flags, "receive-id") ?? "",
                ...(bodyMaxElements ? { bodyMaxElements } : {}),
                ...(panelMaxElements ? { panelMaxElements } : {}),
                ...(maxRequestBytes ? { maxRequestBytes } : {}),
                ...(maxItemsPerGroup ? { maxItemsPerGroup } : {}),
                ...(maxItemsPerCard ? { maxItemsPerCard } : {}),
                ...(style === "table-summary" ? { renderCard } : {}),
            });
            return {
                type: "inline_v2_shards",
                data: {
                    cards: shards.map((shard) => shard.card),
                    card_shards: shards.map((shard) => ({ task_ids: shard.taskIds })),
                },
            };
        }
        return renderCard(input);
    }
    if (resource === "action" && action === "handle-card-event") {
        const event = parseEventJson(args);
        const result = await handleApprovalCardEvent(event, {
            allowProcessing: booleanFlag(args.flags, "allow-processing"),
        });
        const includeCard = booleanFlag(args.flags, "include-card");
        const includeSnapshot = booleanFlag(args.flags, "include-snapshot");
        const style = approvalCardStyle(args.flags, result.snapshot?.card_style);
        const card = includeCard && result.snapshot
            ? rendererForCardStyle(style)(approvalCardRenderInput(createApprovalCardState(result.snapshot)))
            : undefined;
        return okEnvelope({
            toast: result.toast,
            updated: Boolean(result.snapshot),
            ...(includeSnapshot && result.snapshot ? { snapshot: result.snapshot } : {}),
            ...(card ? { card } : {}),
        }, { requestId: randomUUID() });
    }
    if (resource === "action" && action === "mark-processing") {
        const event = parseEventJson(args);
        const result = markApprovalCardEventProcessing(event);
        const includeCard = booleanFlag(args.flags, "include-card");
        const includeSnapshot = booleanFlag(args.flags, "include-snapshot");
        const style = approvalCardStyle(args.flags, result.snapshot?.card_style);
        const card = includeCard && result.snapshot
            ? rendererForCardStyle(style)(approvalCardRenderInput(createApprovalCardState(result.snapshot)))
            : undefined;
        return okEnvelope({
            toast: result.toast,
            updated: Boolean(result.snapshot),
            claimed_task_ids: result.claimedTaskIds ?? [],
            claimed: Boolean(result.claimedTaskIds?.length),
            ...(includeSnapshot && result.snapshot ? { snapshot: result.snapshot } : {}),
            ...(card ? { card } : {}),
        }, { requestId: randomUUID() });
    }
    if (resource === "action" && (action === "approve" || action === "reject")) {
        const taskId = stringFlag(args.flags, "task-id");
        if (!taskId) {
            throw new WorkkitError(WorkkitErrorCode.InvalidInput, "--task-id is required for approval action.");
        }
        const snapshotPath = stringFlag(args.flags, "snapshot");
        const comment = stringFlag(args.flags, "comment");
        const result = await approveOrRejectFromSnapshot({
            operation: action,
            taskId,
            ...(snapshotPath ? { snapshotPath } : {}),
            ...(comment ? { comment } : {}),
        });
        return okEnvelope(result, { requestId: randomUUID() });
    }
    if (resource === "action" && action === "text") {
        const command = args.positionals.slice(3).join(" ").trim();
        if (!command) {
            throw new WorkkitError(WorkkitErrorCode.InvalidInput, "Text approval command is required.");
        }
        const result = await handleApprovalTextAction(command);
        return okEnvelope(result, { requestId: randomUUID() });
    }
    return errorEnvelope({
        code: WorkkitErrorCode.InvalidInput,
        message: `Unsupported approval command: ${args.positionals.join(" ")}`,
    }, { requestId: randomUUID() });
}
function resolveIdentityFromFlags(args) {
    const user = stringFlag(args.flags, "user") ?? "current";
    const identityMapPath = stringFlag(args.flags, "identity-map") ?? "config/identity-map.example.json";
    if (!existsSync(resolve(identityMapPath))) {
        return { canonicalUserId: user };
    }
    const identityMap = JSON.parse(readFileSync(resolve(identityMapPath), "utf8"));
    try {
        return resolveIdentity(user, identityMap);
    }
    catch (error) {
        if (user === "current") {
            return { canonicalUserId: user };
        }
        throw error;
    }
}
function numberFlag(flags, key) {
    const value = stringFlag(flags, key);
    return value ? Number(value) : undefined;
}
function booleanFlag(flags, key) {
    return flags[key] === true || stringFlag(flags, key) === "true";
}
function parseJsonFlag(flags, key) {
    const value = stringFlag(flags, key);
    if (!value) {
        return undefined;
    }
    return JSON.parse(value);
}
function parseEventJson(args) {
    const raw = stringFlag(args.flags, "event-json");
    const filePath = stringFlag(args.flags, "event-file");
    if (raw) {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    if (filePath) {
        const parsed = JSON.parse(readFileSync(resolve(filePath), "utf8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    throw new WorkkitError(WorkkitErrorCode.InvalidInput, "--event-json or --event-file is required.");
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function parseSources(value) {
    if (!value) {
        return undefined;
    }
    return value
        .split(",")
        .map((source) => source.trim())
        .filter(Boolean);
}
function feishuProfileOptions(args) {
    const profileName = stringFlag(args.flags, "lark-profile");
    return profileName ? { profileName } : {};
}
function approvalCardStyle(flags, fallback) {
    const raw = stringFlag(flags, "style") ??
        stringFlag(flags, "card-style") ??
        fallback ??
        process.env.WORKKIT_APPROVAL_CARD_STYLE ??
        process.env.APPROVAL_CARD_STYLE ??
        "table-summary";
    const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
    if (normalized === "collapse" || normalized === "old" || normalized === "legacy") {
        return "collapse";
    }
    if (normalized === "simple" || normalized === "list") {
        return "simple";
    }
    return "table-summary";
}
function rendererForCardStyle(style) {
    return style === "collapse" ? renderCollapseInboxCard : renderApprovalTableSummaryCard;
}
//# sourceMappingURL=index.js.map