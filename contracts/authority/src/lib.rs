mod registry;
mod treasury;
pub mod types;

use near_sdk::{PanicOnDefault, env, near, store::LookupMap};
use types::*;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Authority {
    agents: LookupMap<String, Agent>,
    jobs: LookupMap<String, Job>,
    withdrawals: LookupMap<String, Withdrawal>,
    storage_credits_total: u128,
    pending_outgoing: u128,
}

#[near]
impl Authority {
    #[init]
    pub fn new() -> Self {
        Self {
            agents: LookupMap::new(b"a"),
            jobs: LookupMap::new(b"j"),
            withdrawals: LookupMap::new(b"w"),
            storage_credits_total: 0,
            pending_outgoing: 0,
        }
    }
}

impl Authority {
    fn agent(&self, id: &str) -> Agent {
        self.agents.get(id).expect("ERR_AGENT_NOT_FOUND").clone()
    }

    fn key(agent_id: &str, operation_id: &str) -> String {
        validate_id(agent_id, 128);
        validate_id(operation_id, 64);
        format!("{agent_id}|{operation_id}")
    }

    fn assert_direct() {
        assert_eq!(
            env::predecessor_account_id(),
            env::signer_account_id(),
            "ERR_DIRECT_CALL_REQUIRED"
        );
    }

    fn is_owner(agent: &Agent) -> bool {
        env::predecessor_account_id() == agent.owner
            && env::signer_account_id() == agent.owner
            && env::signer_account_pk() == agent.owner_key
    }

    fn assert_owner(agent: &Agent) {
        Self::assert_direct();
        assert!(Self::is_owner(agent), "ERR_OWNER_KEY_REQUIRED");
    }

    fn assert_runtime(agent: &Agent, generation: u64, spend: bool) {
        Self::assert_direct();
        assert!(!agent.paused, "ERR_AGENT_PAUSED");
        assert_eq!(agent.generation, generation, "ERR_STALE_GENERATION");
        if Self::is_owner(agent) {
            return;
        }
        assert_eq!(
            env::signer_account_id(),
            agent.owner,
            "ERR_UNAUTHORIZED_ACCOUNT"
        );
        let key = env::signer_account_pk();
        let delegate = agent
            .delegates
            .iter()
            .find(|d| d.public_key == key)
            .expect("ERR_UNAUTHORIZED_KEY");
        assert!(
            delegate.expires_at_ns.0 > env::block_timestamp(),
            "ERR_DELEGATE_EXPIRED"
        );
        assert!(
            if spend {
                delegate.can_spend
            } else {
                delegate.can_checkpoint
            },
            "ERR_PERMISSION"
        );
    }

    fn save_agent(&mut self, mut agent: Agent, before: u64) {
        assert_eq!(
            agent.deposited,
            agent
                .available
                .checked_add(agent.reserved)
                .and_then(|n| n.checked_add(agent.pending))
                .and_then(|n| n.checked_add(agent.paid))
                .and_then(|n| n.checked_add(agent.withdrawn))
                .expect("ERR_ACCOUNTING_OVERFLOW"),
            "ERR_ACCOUNTING_CONSERVATION"
        );
        let id = agent.id.clone();
        self.jobs.flush();
        self.withdrawals.flush();
        self.agents.insert(id.clone(), agent.clone());
        self.agents.flush();
        let after = env::storage_usage();
        let price = env::storage_byte_cost().as_yoctonear();
        if after >= before {
            let cost = u128::from(after - before)
                .checked_mul(price)
                .expect("ERR_STORAGE_OVERFLOW");
            agent.storage_credit = agent
                .storage_credit
                .checked_sub(cost)
                .expect("ERR_STORAGE_CREDIT");
            self.storage_credits_total = self
                .storage_credits_total
                .checked_sub(cost)
                .expect("ERR_STORAGE_ACCOUNTING");
        } else {
            let released = u128::from(before - after)
                .checked_mul(price)
                .expect("ERR_STORAGE_OVERFLOW");
            agent.storage_credit = agent
                .storage_credit
                .checked_add(released)
                .expect("ERR_STORAGE_OVERFLOW");
            self.storage_credits_total = self
                .storage_credits_total
                .checked_add(released)
                .expect("ERR_STORAGE_OVERFLOW");
        }
        // Fixed-width balances do not change the serialized size on this second write.
        self.agents.insert(id, agent);
        self.agents.flush();
    }

    fn event(name: &str, data: near_sdk::serde_json::Value) {
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({ "standard": "persistara", "version": "1.0.0", "event": name, "data": [data] })
        ));
    }
}

#[cfg(test)]
mod tests;
