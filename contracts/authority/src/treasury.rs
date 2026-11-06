use crate::{Authority, AuthorityExt, types::*};
use near_sdk::{
    Gas, NearToken, Promise, PromiseError, env,
    json_types::{U64, U128},
    near,
};

#[near]
impl Authority {
    pub fn configure_policy(&mut self, agent_id: String, policy: Policy) -> AgentView {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        policy.validate();
        let before = env::storage_usage();
        agent.policy = Some(policy);
        agent.policy_version = agent
            .policy_version
            .checked_add(1)
            .expect("ERR_POLICY_OVERFLOW");
        agent.generation = agent
            .generation
            .checked_add(1)
            .expect("ERR_GENERATION_OVERFLOW");
        self.save_agent(agent, before);
        self.get_agent(agent_id).unwrap()
    }

    #[payable]
    pub fn fund(&mut self, agent_id: String) -> AgentView {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let amount = env::attached_deposit().as_yoctonear();
        assert!(amount > 0, "ERR_ZERO_DEPOSIT");
        let before = env::storage_usage();
        agent.deposited = agent
            .deposited
            .checked_add(amount)
            .expect("ERR_BALANCE_OVERFLOW");
        agent.available = agent
            .available
            .checked_add(amount)
            .expect("ERR_BALANCE_OVERFLOW");
        self.save_agent(agent, before);
        Self::event(
            "treasury_funded",
            near_sdk::serde_json::json!({ "agentId": agent_id, "amount": U128(amount) }),
        );
        self.get_agent(agent_id).unwrap()
    }

    pub fn create_job(&mut self, request: JobRequest) -> JobView {
        let mut agent = self.agent(&request.agent_id);
        Self::assert_runtime(&agent, request.generation.0, true);
        let key = Self::key(&request.agent_id, &request.operation_id);
        let digest =
            env::sha256(near_sdk::serde_json::to_vec(&request).expect("ERR_REQUEST_SERIALIZATION"));
        if let Some(prior) = self.jobs.get(&key) {
            assert_eq!(prior.request_digest, digest, "ERR_OPERATION_CONFLICT");
            return JobView::from(prior);
        }
        let policy = agent.policy.as_ref().expect("ERR_POLICY_REQUIRED");
        assert_eq!(
            agent.policy_version, request.policy_version.0,
            "ERR_STALE_POLICY"
        );
        assert!(
            request.amount.0 > 0 && request.amount.0 <= policy.max_job_amount.0,
            "ERR_JOB_LIMIT"
        );
        assert!(
            policy.approved_workers.contains(&request.worker),
            "ERR_WORKER_NOT_APPROVED"
        );
        assert!(
            request.criteria_hash.len() == 64 && lower_hex(&request.criteria_hash),
            "ERR_CRITERIA_HASH"
        );
        request.brief.validate();
        let now = env::block_timestamp();
        assert!(
            request.quote_expires_at_ns.0 > now
                && request.quote_expires_at_ns.0 <= request.delivery_deadline_ns.0,
            "ERR_QUOTE_EXPIRED"
        );
        assert!(
            request.delivery_deadline_ns.0 > now
                && request.delivery_deadline_ns.0
                    <= now.checked_add(7 * DAY_NS).expect("ERR_TIME_OVERFLOW"),
            "ERR_DELIVERY_DEADLINE"
        );
        assert!(
            (HOUR_NS..=7 * DAY_NS).contains(&request.review_window_ns.0),
            "ERR_REVIEW_WINDOW"
        );
        let window = now / DAY_NS;
        if agent.budget_window != window {
            agent.budget_window = window;
            agent.allocated = 0;
        }
        let allocated = agent
            .allocated
            .checked_add(request.amount.0)
            .expect("ERR_BUDGET_OVERFLOW");
        assert!(allocated <= policy.daily_limit.0, "ERR_DAILY_LIMIT");
        assert!(
            request.amount.0 <= agent.available,
            "ERR_INSUFFICIENT_FUNDS"
        );
        let before = env::storage_usage();
        agent.available -= request.amount.0;
        agent.reserved = agent
            .reserved
            .checked_add(request.amount.0)
            .expect("ERR_BALANCE_OVERFLOW");
        agent.allocated = allocated;
        // The worker can still deliver if other operations exhaust the buyer's free storage credit.
        let storage_reserve = 4096u128
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("ERR_STORAGE_OVERFLOW");
        agent.storage_credit = agent
            .storage_credit
            .checked_sub(storage_reserve)
            .expect("ERR_JOB_STORAGE_RESERVE");
        agent.storage_reserved = agent
            .storage_reserved
            .checked_add(storage_reserve)
            .expect("ERR_STORAGE_OVERFLOW");
        let agent_id = request.agent_id.clone();
        let operation_id = request.operation_id.clone();
        let job = Job {
            request,
            request_digest: digest,
            status: JobStatus::Funded,
            result: None,
            review_deadline_ns: 0,
            dispute_deadline_ns: 0,
            payout_attempt: 0,
            storage_reserve,
        };
        self.jobs.insert(key, job.clone());
        self.save_agent(agent, before);
        Self::event(
            "job_reserved",
            near_sdk::serde_json::json!({ "agentId": agent_id, "operationId": operation_id, "amount": job.request.amount }),
        );
        JobView::from(&job)
    }

    pub fn deliver(&mut self, agent_id: String, operation_id: String, result: BlobRef) -> JobView {
        Self::assert_direct();
        result.validate();
        let key = Self::key(&agent_id, &operation_id);
        let mut job = self.jobs.get(&key).expect("ERR_JOB_NOT_FOUND").clone();
        assert_eq!(
            env::signer_account_id(),
            job.request.worker,
            "ERR_WORKER_REQUIRED"
        );
        if job.result.as_ref() == Some(&result) {
            return JobView::from(&job);
        }
        assert_eq!(job.status, JobStatus::Funded, "ERR_JOB_STATE");
        assert!(
            env::block_timestamp() <= job.request.delivery_deadline_ns.0,
            "ERR_DELIVERY_EXPIRED"
        );
        let before = env::storage_usage();
        let mut agent = self.agent(&agent_id);
        Self::release_job_storage(&mut agent, &mut job);
        job.result = Some(result);
        job.review_deadline_ns = env::block_timestamp()
            .checked_add(job.request.review_window_ns.0)
            .expect("ERR_TIME_OVERFLOW");
        job.status = JobStatus::Delivered;
        self.jobs.insert(key, job.clone());
        self.save_agent(agent, before);
        Self::event(
            "job_delivered",
            near_sdk::serde_json::json!({ "agentId": agent_id, "operationId": operation_id }),
        );
        JobView::from(&job)
    }

    pub fn accept_job(
        &mut self,
        agent_id: String,
        operation_id: String,
        generation: U64,
        expected_result_digest: String,
    ) -> JobView {
        let agent = self.agent(&agent_id);
        if Self::is_owner(&agent) {
            Self::assert_owner(&agent);
        } else {
            Self::assert_runtime(&agent, generation.0, true);
        }
        let job = self
            .jobs
            .get(&Self::key(&agent_id, &operation_id))
            .expect("ERR_JOB_NOT_FOUND")
            .clone();
        assert_eq!(
            job.result
                .as_ref()
                .expect("ERR_DELIVERY_REQUIRED")
                .ciphertext_sha256,
            expected_result_digest,
            "ERR_ARTIFACT_CHANGED"
        );
        if matches!(
            job.status,
            JobStatus::PayoutPending | JobStatus::PayoutFailed | JobStatus::Paid
        ) {
            return JobView::from(&job);
        }
        assert_eq!(job.status, JobStatus::Delivered, "ERR_JOB_STATE");
        self.start_payout(agent, job)
    }

    pub fn cancel_job(&mut self, agent_id: String, operation_id: String) -> JobView {
        let agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let job = self
            .jobs
            .get(&Self::key(&agent_id, &operation_id))
            .expect("ERR_JOB_NOT_FOUND")
            .clone();
        if job.status == JobStatus::Refunded {
            return JobView::from(&job);
        }
        assert_eq!(job.status, JobStatus::Funded, "ERR_JOB_STATE");
        self.refund_to_treasury(agent, job)
    }

    pub fn dispute_job(&mut self, agent_id: String, operation_id: String) -> JobView {
        let agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let key = Self::key(&agent_id, &operation_id);
        let mut job = self.jobs.get(&key).expect("ERR_JOB_NOT_FOUND").clone();
        if job.status == JobStatus::Disputed {
            return JobView::from(&job);
        }
        assert_eq!(job.status, JobStatus::Delivered, "ERR_JOB_STATE");
        assert!(
            env::block_timestamp() <= job.review_deadline_ns,
            "ERR_REVIEW_EXPIRED"
        );
        let before = env::storage_usage();
        job.status = JobStatus::Disputed;
        job.dispute_deadline_ns = env::block_timestamp()
            .checked_add(7 * DAY_NS)
            .expect("ERR_TIME_OVERFLOW");
        self.jobs.insert(key, job.clone());
        self.save_agent(agent, before);
        JobView::from(&job)
    }

    pub fn resolve_dispute(
        &mut self,
        agent_id: String,
        operation_id: String,
        pay_worker: bool,
    ) -> JobView {
        let agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let job = self
            .jobs
            .get(&Self::key(&agent_id, &operation_id))
            .expect("ERR_JOB_NOT_FOUND")
            .clone();
        assert_eq!(job.status, JobStatus::Disputed, "ERR_JOB_STATE");
        assert!(
            env::block_timestamp() <= job.dispute_deadline_ns,
            "ERR_DISPUTE_EXPIRED"
        );
        if pay_worker {
            self.start_payout(agent, job)
        } else {
            self.refund_to_treasury(agent, job)
        }
    }

    /// Permissionless progress for obligations that were already authorized.
    pub fn advance_timeout(&mut self, agent_id: String, operation_id: String) -> JobView {
        let agent = self.agent(&agent_id);
        let job = self
            .jobs
            .get(&Self::key(&agent_id, &operation_id))
            .expect("ERR_JOB_NOT_FOUND")
            .clone();
        let now = env::block_timestamp();
        match job.status {
            JobStatus::Funded => {
                assert!(now > job.request.delivery_deadline_ns.0, "ERR_NOT_DUE");
                self.refund_to_treasury(agent, job)
            }
            JobStatus::Delivered => {
                assert!(now > job.review_deadline_ns, "ERR_NOT_DUE");
                self.start_payout(agent, job)
            }
            JobStatus::Disputed => {
                assert!(now > job.dispute_deadline_ns, "ERR_NOT_DUE");
                self.refund_to_treasury(agent, job)
            }
            _ => JobView::from(&job),
        }
    }

    pub fn retry_payout(&mut self, agent_id: String, operation_id: String) -> JobView {
        let agent = self.agent(&agent_id);
        let job = self
            .jobs
            .get(&Self::key(&agent_id, &operation_id))
            .expect("ERR_JOB_NOT_FOUND")
            .clone();
        if matches!(job.status, JobStatus::PayoutPending | JobStatus::Paid) {
            return JobView::from(&job);
        }
        assert_eq!(job.status, JobStatus::PayoutFailed, "ERR_JOB_STATE");
        self.start_payout(agent, job)
    }

    #[private]
    pub fn on_payout(
        &mut self,
        agent_id: String,
        operation_id: String,
        attempt: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        self.assert_callback();
        let key = Self::key(&agent_id, &operation_id);
        let mut job = self.jobs.get(&key).expect("ERR_JOB_NOT_FOUND").clone();
        if job.status != JobStatus::PayoutPending || job.payout_attempt != attempt.0 {
            return false;
        }
        let before = env::storage_usage();
        let mut agent = self.agent(&agent_id);
        let amount = job.request.amount.0;
        agent.pending = agent.pending.checked_sub(amount).expect("ERR_ACCOUNTING");
        self.pending_outgoing = self
            .pending_outgoing
            .checked_sub(amount)
            .expect("ERR_ACCOUNTING");
        if result.is_ok() {
            agent.paid = agent.paid.checked_add(amount).expect("ERR_ACCOUNTING");
            job.status = JobStatus::Paid;
        } else {
            agent.reserved = agent.reserved.checked_add(amount).expect("ERR_ACCOUNTING");
            job.status = JobStatus::PayoutFailed;
        }
        self.jobs.insert(key, job);
        self.save_agent(agent, before);
        Self::event(
            "payout_resolved",
            near_sdk::serde_json::json!({ "agentId": agent_id, "operationId": operation_id, "attempt": attempt, "success": result.is_ok() }),
        );
        result.is_ok()
    }

    pub fn withdraw_funds(
        &mut self,
        agent_id: String,
        operation_id: String,
        amount: U128,
    ) -> Withdrawal {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        assert!(amount.0 > 0, "ERR_ZERO_AMOUNT");
        let key = Self::key(&agent_id, &operation_id);
        if let Some(prior) = self.withdrawals.get(&key) {
            assert_eq!(prior.amount.0, amount.0, "ERR_OPERATION_CONFLICT");
            return prior.clone();
        }
        assert!(agent.available >= amount.0, "ERR_INSUFFICIENT_FUNDS");
        let before = env::storage_usage();
        agent.available -= amount.0;
        agent.pending = agent.pending.checked_add(amount.0).expect("ERR_ACCOUNTING");
        self.pending_outgoing = self
            .pending_outgoing
            .checked_add(amount.0)
            .expect("ERR_ACCOUNTING");
        let withdrawal = Withdrawal {
            agent_id: agent_id.clone(),
            operation_id: operation_id.clone(),
            amount,
            attempt: U64(1),
            status: WithdrawalStatus::Pending,
        };
        let owner = agent.owner.clone();
        self.withdrawals.insert(key, withdrawal.clone());
        self.save_agent(agent, before);
        self.assert_transfer_reserve();
        self.schedule_withdrawal(owner, withdrawal.clone());
        withdrawal
    }

    pub fn retry_withdrawal(&mut self, agent_id: String, operation_id: String) -> Withdrawal {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let key = Self::key(&agent_id, &operation_id);
        let mut withdrawal = self
            .withdrawals
            .get(&key)
            .expect("ERR_WITHDRAWAL_NOT_FOUND")
            .clone();
        if withdrawal.status != WithdrawalStatus::Failed {
            return withdrawal;
        }
        let amount = withdrawal.amount.0;
        assert!(agent.available >= amount, "ERR_INSUFFICIENT_FUNDS");
        let before = env::storage_usage();
        agent.available -= amount;
        agent.pending = agent.pending.checked_add(amount).expect("ERR_ACCOUNTING");
        self.pending_outgoing = self
            .pending_outgoing
            .checked_add(amount)
            .expect("ERR_ACCOUNTING");
        withdrawal.attempt = U64(withdrawal
            .attempt
            .0
            .checked_add(1)
            .expect("ERR_ATTEMPT_OVERFLOW"));
        withdrawal.status = WithdrawalStatus::Pending;
        let owner = agent.owner.clone();
        self.withdrawals.insert(key, withdrawal.clone());
        self.save_agent(agent, before);
        self.assert_transfer_reserve();
        self.schedule_withdrawal(owner, withdrawal.clone());
        withdrawal
    }

    #[private]
    pub fn on_withdrawal(
        &mut self,
        agent_id: String,
        operation_id: String,
        attempt: U64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        self.assert_callback();
        let key = Self::key(&agent_id, &operation_id);
        let mut withdrawal = self
            .withdrawals
            .get(&key)
            .expect("ERR_WITHDRAWAL_NOT_FOUND")
            .clone();
        if withdrawal.status != WithdrawalStatus::Pending || withdrawal.attempt != attempt {
            return false;
        }
        let before = env::storage_usage();
        let mut agent = self.agent(&agent_id);
        let amount = withdrawal.amount.0;
        agent.pending = agent.pending.checked_sub(amount).expect("ERR_ACCOUNTING");
        self.pending_outgoing = self
            .pending_outgoing
            .checked_sub(amount)
            .expect("ERR_ACCOUNTING");
        if result.is_ok() {
            agent.withdrawn = agent.withdrawn.checked_add(amount).expect("ERR_ACCOUNTING");
            withdrawal.status = WithdrawalStatus::Paid;
        } else {
            agent.available = agent.available.checked_add(amount).expect("ERR_ACCOUNTING");
            withdrawal.status = WithdrawalStatus::Failed;
        }
        self.withdrawals.insert(key, withdrawal);
        self.save_agent(agent, before);
        result.is_ok()
    }

    pub fn get_job(&self, agent_id: String, operation_id: String) -> Option<JobView> {
        self.jobs
            .get(&Self::key(&agent_id, &operation_id))
            .map(JobView::from)
    }
    pub fn get_withdrawal(&self, agent_id: String, operation_id: String) -> Option<Withdrawal> {
        self.withdrawals
            .get(&Self::key(&agent_id, &operation_id))
            .cloned()
    }
}

impl Authority {
    fn refund_to_treasury(&mut self, mut agent: Agent, mut job: Job) -> JobView {
        let before = env::storage_usage();
        Self::release_job_storage(&mut agent, &mut job);
        agent.reserved = agent
            .reserved
            .checked_sub(job.request.amount.0)
            .expect("ERR_ACCOUNTING");
        agent.available = agent
            .available
            .checked_add(job.request.amount.0)
            .expect("ERR_ACCOUNTING");
        job.status = JobStatus::Refunded;
        self.jobs.insert(
            Self::key(&job.request.agent_id, &job.request.operation_id),
            job.clone(),
        );
        self.save_agent(agent, before);
        Self::event(
            "job_refunded_to_treasury",
            near_sdk::serde_json::json!({ "agentId": job.request.agent_id, "operationId": job.request.operation_id }),
        );
        JobView::from(&job)
    }

    fn start_payout(&mut self, mut agent: Agent, mut job: Job) -> JobView {
        let before = env::storage_usage();
        let amount = job.request.amount.0;
        agent.reserved = agent.reserved.checked_sub(amount).expect("ERR_ACCOUNTING");
        agent.pending = agent.pending.checked_add(amount).expect("ERR_ACCOUNTING");
        self.pending_outgoing = self
            .pending_outgoing
            .checked_add(amount)
            .expect("ERR_ACCOUNTING");
        job.payout_attempt = job
            .payout_attempt
            .checked_add(1)
            .expect("ERR_ATTEMPT_OVERFLOW");
        job.status = JobStatus::PayoutPending;
        self.jobs.insert(
            Self::key(&job.request.agent_id, &job.request.operation_id),
            job.clone(),
        );
        self.save_agent(agent, before);
        self.assert_transfer_reserve();
        Promise::new(job.request.worker.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_payout(
                        job.request.agent_id.clone(),
                        job.request.operation_id.clone(),
                        U64(job.payout_attempt),
                    ),
            )
            .detach();
        JobView::from(&job)
    }

    fn schedule_withdrawal(&self, owner: near_sdk::AccountId, withdrawal: Withdrawal) {
        Promise::new(owner)
            .transfer(NearToken::from_yoctonear(withdrawal.amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_withdrawal(
                        withdrawal.agent_id,
                        withdrawal.operation_id,
                        withdrawal.attempt,
                    ),
            )
            .detach();
    }

    fn assert_callback(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "ERR_PRIVATE_CALLBACK"
        );
        assert_eq!(env::promise_results_count(), 1, "ERR_CALLBACK_RESULT");
    }

    fn release_job_storage(agent: &mut Agent, job: &mut Job) {
        agent.storage_reserved = agent
            .storage_reserved
            .checked_sub(job.storage_reserve)
            .expect("ERR_STORAGE_ACCOUNTING");
        agent.storage_credit = agent
            .storage_credit
            .checked_add(job.storage_reserve)
            .expect("ERR_STORAGE_OVERFLOW");
        job.storage_reserve = 0;
    }

    fn assert_transfer_reserve(&self) {
        let storage = u128::from(env::storage_usage())
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("ERR_STORAGE_OVERFLOW");
        let needed = storage
            .checked_add(self.storage_credits_total)
            .and_then(|n| n.checked_add(self.pending_outgoing))
            .and_then(|n| n.checked_add(OPERATING_RESERVE))
            .expect("ERR_RESERVE_OVERFLOW");
        assert!(
            env::account_balance().as_yoctonear() >= needed,
            "ERR_CONTRACT_RESERVE"
        );
    }
}
