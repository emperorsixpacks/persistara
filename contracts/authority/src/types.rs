use near_sdk::{
    AccountId, PublicKey,
    json_types::{U64, U128},
    near,
};

pub const DAY_NS: u64 = 86_400_000_000_000;
pub const HOUR_NS: u64 = 3_600_000_000_000;
pub const MAX_DELEGATES: usize = 8;
pub const MAX_WORKERS: usize = 16;
pub const OPERATING_RESERVE: u128 = 10_000_000_000_000_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub provider: String,
    pub network: String,
    pub object_id: String,
    pub ciphertext_sha256: String,
    pub byte_length: u32,
}

impl BlobRef {
    pub fn validate(&self) {
        assert!(self.provider == "0g", "ERR_STORAGE_PROVIDER");
        assert!(
            matches!(
                self.network.as_str(),
                "0g:16602:turbo" | "0g:16602:standard"
            ),
            "ERR_STORAGE_NETWORK"
        );
        assert!(
            self.object_id.len() == 66
                && self.object_id.starts_with("0x")
                && lower_hex(&self.object_id[2..]),
            "ERR_STORAGE_ROOT"
        );
        assert!(
            self.ciphertext_sha256.len() == 64 && lower_hex(&self.ciphertext_sha256),
            "ERR_CIPHERTEXT_DIGEST"
        );
        assert!(
            self.byte_length > 0 && self.byte_length <= 1_500_000,
            "ERR_BLOB_SIZE"
        );
    }
}

pub fn lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn validate_id(value: &str, max: usize) {
    assert!(
        !value.is_empty()
            && value.len() <= max
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b)),
        "ERR_ID"
    );
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHead {
    pub version: U64,
    pub key_epoch: U64,
    pub manifest: BlobRef,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Delegate {
    pub public_key: PublicKey,
    pub expires_at_ns: U64,
    pub can_checkpoint: bool,
    pub can_spend: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRotationRequest {
    pub agent_id: String,
    pub operation_id: String,
    pub expected_generation: U64,
    pub expected_epoch: U64,
    pub expected_version: U64,
    pub old_public_key: PublicKey,
    pub replacement: Delegate,
    pub recovery_commitment: String,
    pub resume: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRotation {
    pub request: RuntimeRotationRequest,
    pub next_epoch: U64,
    pub begin_generation: U64,
    pub completed: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub max_job_amount: U128,
    pub daily_limit: U128,
    pub approved_workers: Vec<AccountId>,
}

impl Policy {
    pub fn validate(&self) {
        assert!(
            self.max_job_amount.0 > 0 && self.daily_limit.0 >= self.max_job_amount.0,
            "ERR_BUDGET_POLICY"
        );
        assert!(
            !self.approved_workers.is_empty() && self.approved_workers.len() <= MAX_WORKERS,
            "ERR_WORKER_POLICY"
        );
        let mut sorted = self.approved_workers.clone();
        sorted.sort();
        sorted.dedup();
        assert!(
            sorted.len() == self.approved_workers.len(),
            "ERR_DUPLICATE_WORKER"
        );
    }
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Agent {
    pub id: String,
    pub owner: AccountId,
    pub owner_key: PublicKey,
    pub paused: bool,
    pub generation: u64,
    pub key_epoch: u64,
    pub policy_version: u64,
    pub delegates: Vec<Delegate>,
    pub head: Option<MemoryHead>,
    pub policy: Option<Policy>,
    pub storage_credit: u128,
    pub storage_reserved: u128,
    pub deposited: u128,
    pub available: u128,
    pub reserved: u128,
    pub pending: u128,
    pub paid: u128,
    pub withdrawn: u128,
    pub budget_window: u64,
    pub allocated: u128,
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub id: String,
    pub owner: AccountId,
    pub owner_key: PublicKey,
    pub paused: bool,
    pub generation: U64,
    pub key_epoch: U64,
    pub policy_version: U64,
    pub delegates: Vec<Delegate>,
    pub head: Option<MemoryHead>,
    pub policy: Option<Policy>,
    pub storage_credit: U128,
    pub storage_reserved: U128,
    pub deposited: U128,
    pub available: U128,
    pub reserved: U128,
    pub pending: U128,
    pub paid: U128,
    pub withdrawn: U128,
    pub budget_window: U64,
    pub allocated: U128,
}

impl From<&Agent> for AgentView {
    fn from(a: &Agent) -> Self {
        Self {
            id: a.id.clone(),
            owner: a.owner.clone(),
            owner_key: a.owner_key.clone(),
            paused: a.paused,
            generation: U64(a.generation),
            key_epoch: U64(a.key_epoch),
            policy_version: U64(a.policy_version),
            delegates: a.delegates.clone(),
            head: a.head.clone(),
            policy: a.policy.clone(),
            storage_credit: U128(a.storage_credit),
            storage_reserved: U128(a.storage_reserved),
            deposited: U128(a.deposited),
            available: U128(a.available),
            reserved: U128(a.reserved),
            pending: U128(a.pending),
            paid: U128(a.paid),
            withdrawn: U128(a.withdrawn),
            budget_window: U64(a.budget_window),
            allocated: U128(a.allocated),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Funded,
    Delivered,
    Disputed,
    PayoutPending,
    PayoutFailed,
    Paid,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub agent_id: String,
    pub generation: U64,
    pub policy_version: U64,
    pub operation_id: String,
    pub worker: AccountId,
    pub amount: U128,
    pub criteria_hash: String,
    pub brief: BlobRef,
    pub quote_expires_at_ns: U64,
    pub delivery_deadline_ns: U64,
    pub review_window_ns: U64,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Job {
    pub request: JobRequest,
    pub request_digest: Vec<u8>,
    pub status: JobStatus,
    pub result: Option<BlobRef>,
    pub review_deadline_ns: u64,
    pub dispute_deadline_ns: u64,
    pub payout_attempt: u64,
    pub storage_reserve: u128,
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub request: JobRequest,
    pub status: JobStatus,
    pub result: Option<BlobRef>,
    pub review_deadline_ns: U64,
    pub dispute_deadline_ns: U64,
    pub payout_attempt: U64,
}

impl From<&Job> for JobView {
    fn from(j: &Job) -> Self {
        Self {
            request: j.request.clone(),
            status: j.status.clone(),
            result: j.result.clone(),
            review_deadline_ns: U64(j.review_deadline_ns),
            dispute_deadline_ns: U64(j.dispute_deadline_ns),
            payout_attempt: U64(j.payout_attempt),
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum WithdrawalStatus {
    Pending,
    Failed,
    Paid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(rename_all = "camelCase")]
pub struct Withdrawal {
    pub agent_id: String,
    pub operation_id: String,
    pub amount: U128,
    pub attempt: U64,
    pub status: WithdrawalStatus,
}
