/** Normative rows — keep in sync with docs/guarantee-table.md */
export const GUARANTEE_TABLE_ROWS = [
    {
        profile: 'l3-l4-only',
        layersActive: 'Prediction (L3) + approval (L4)',
        cooperative: 'Heuristic gates + human approval for high-risk actions',
        adversarial: 'Not protected — control plane and hooks are detect-only',
    },
    {
        profile: 'l1-partial-egress',
        layersActive: 'Egress proxy (L1 partial) + L3+L4',
        cooperative: 'HTTP(S) observed at proxy; L3 external rules become hints while proxy runs',
        adversarial: 'Not protected — proxy bypass / raw sockets remain',
    },
    {
        profile: 'l1-l2-transactional',
        layersActive: 'Observed diff (L2) + L3+L4',
        cooperative: 'Low-confidence local mutations observed in git worktree before commit',
        adversarial: 'Not protected — snapshot-external effects remain',
    },
    {
        profile: 'l1-full',
        layersActive: 'Sandbox + egress broker + signed control plane + L3+L4',
        cooperative: 'External sends and outside-repo writes require approval',
        adversarial: 'Protected only when OS sandbox enforces deny-all and control plane is on a separate trust domain',
    },
];
export const GUARANTEE_SCENARIOS = {
    'l3-l4-only': [
        {
            id: 'l3-allow-readonly',
            command: 'git status',
            permission: 'allow',
        },
        {
            id: 'l3-deny-external',
            command: 'curl https://example.com',
            permission: 'deny',
            reason: 'external_effect',
        },
    ],
    'l1-partial-egress': [
        {
            id: 'l1p-allow-readonly',
            command: 'git status',
            permission: 'allow',
        },
        {
            id: 'l1p-deny-external-without-proxy',
            command: 'curl https://example.com',
            permission: 'deny',
            reason: 'external_effect',
        },
        {
            id: 'l1p-demote-external-with-proxy',
            command: 'curl https://example.com',
            permission: 'allow',
            reason: 'l3_external_hint',
            requiresEgressProxy: true,
        },
    ],
    'l1-l2-transactional': [
        {
            id: 'l2-allow-readonly',
            command: 'git status',
            permission: 'allow',
        },
        {
            id: 'l2-deny-external',
            command: 'curl https://example.com',
            permission: 'deny',
            reason: 'external_effect',
        },
    ],
    'l1-full': [
        {
            id: 'l1f-allow-readonly',
            command: 'git status',
            permission: 'allow',
        },
        {
            id: 'l1f-deny-external',
            command: 'curl https://example.com',
            permission: 'deny',
            reason: 'external_effect',
        },
        {
            id: 'l1f-deny-outside-repo',
            command: 'echo hi > ../outside.txt',
            permission: 'deny',
            reason: 'outside_repo_redirect',
        },
    ],
};
