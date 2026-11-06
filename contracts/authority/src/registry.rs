use crate::{Authority, AuthorityExt, types::*};
use near_sdk::{env, json_types::U64, near};

#[near]
impl Authority {
    #[payable]
    pub fn register_agent(&mut self, name: String) -> AgentView {
        Self::assert_direct();
        assert!(
            !name.is_empty()
                && name.len() <= 32
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
            "ERR_AGENT_NAME"
        );
        let owner = env::signer_account_id();
        let id = format!("{owner}:{name}");
        assert!(!self.agents.contains_key(&id), "ERR_AGENT_EXISTS");
        let storage_credit = env::attached_deposit().as_yoctonear();
        assert!(
            storage_credit >= 100_000_000_000_000_000_000_000,
            "ERR_STORAGE_DEPOSIT"
        );
        let before = env::storage_usage();
        let agent = Agent {
            id: id.clone(),
            owner,
            owner_key: env::signer_account_pk(),
            paused: false,
            generation: 1,
            key_epoch: 1,
            policy_version: 0,
            delegates: vec![],
            head: None,
            policy: None,
            storage_credit,
            storage_reserved: 0,
            deposited: 0,
            available: 0,
            reserved: 0,
            pending: 0,
            paid: 0,
            withdrawn: 0,
            budget_window: env::block_timestamp() / DAY_NS,
            allocated: 0,
        };
        self.storage_credits_total = self
            .storage_credits_total
            .checked_add(storage_credit)
            .expect("ERR_STORAGE_OVERFLOW");
        self.save_agent(agent, before);
        Self::event(
            "agent_registered",
            near_sdk::serde_json::json!({ "agentId": id }),
        );
        self.get_agent(id).unwrap()
    }

    #[payable]
    pub fn add_storage_credit(&mut self, agent_id: String) -> AgentView {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let amount = env::attached_deposit().as_yoctonear();
        assert!(amount > 0, "ERR_ZERO_DEPOSIT");
        let before = env::storage_usage();
        agent.storage_credit = agent
            .storage_credit
            .checked_add(amount)
            .expect("ERR_STORAGE_OVERFLOW");
        self.storage_credits_total = self
            .storage_credits_total
            .checked_add(amount)
            .expect("ERR_STORAGE_OVERFLOW");
        self.save_agent(agent, before);
        self.get_agent(agent_id).unwrap()
    }

    pub fn set_delegate(&mut self, agent_id: String, delegate: Delegate) -> AgentView {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        assert!(
            delegate.public_key != agent.owner_key,
            "ERR_OWNER_CANNOT_BE_DELEGATE"
        );
        assert!(
            delegate.can_checkpoint || delegate.can_spend,
            "ERR_EMPTY_PERMISSION"
        );
        let now = env::block_timestamp();
        assert!(
            delegate.expires_at_ns.0 > now
                && delegate.expires_at_ns.0
                    <= now.checked_add(30 * DAY_NS).expect("ERR_TIME_OVERFLOW"),
            "ERR_DELEGATE_EXPIRY"
        );
        let before = env::storage_usage();
        if let Some(index) = agent
            .delegates
            .iter()
            .position(|d| d.public_key == delegate.public_key)
        {
            agent.delegates[index] = delegate;
        } else {
            assert!(agent.delegates.len() < MAX_DELEGATES, "ERR_DELEGATE_LIMIT");
            agent.delegates.push(delegate);
        }
        agent.generation = agent
            .generation
            .checked_add(1)
            .expect("ERR_GENERATION_OVERFLOW");
        self.save_agent(agent, before);
        Self::event(
            "delegate_updated",
            near_sdk::serde_json::json!({ "agentId": agent_id }),
        );
        self.get_agent(agent_id).unwrap()
    }

    pub fn revoke_delegate(
        &mut self,
        agent_id: String,
        public_key: near_sdk::PublicKey,
    ) -> AgentView {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let before = env::storage_usage();
        agent.delegates.retain(|d| d.public_key != public_key);
        agent.generation = agent
            .generation
            .checked_add(1)
            .expect("ERR_GENERATION_OVERFLOW");
        self.save_agent(agent, before);
        Self::event(
            "delegate_revoked",
            near_sdk::serde_json::json!({ "agentId": agent_id }),
        );
        self.get_agent(agent_id).unwrap()
    }

    pub fn set_paused(&mut self, agent_id: String, paused: bool) -> AgentView {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let before = env::storage_usage();
        agent.paused = paused;
        agent.generation = agent
            .generation
            .checked_add(1)
            .expect("ERR_GENERATION_OVERFLOW");
        self.save_agent(agent, before);
        Self::event(
            "agent_pause_changed",
            near_sdk::serde_json::json!({ "agentId": agent_id, "paused": paused }),
        );
        self.get_agent(agent_id).unwrap()
    }

    pub fn rotate_memory_epoch(&mut self, agent_id: String, next_epoch: U64) -> AgentView {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        assert_eq!(
            next_epoch.0,
            agent.key_epoch.checked_add(1).expect("ERR_EPOCH_OVERFLOW"),
            "ERR_KEY_EPOCH"
        );
        let before = env::storage_usage();
        agent.key_epoch = next_epoch.0;
        agent.generation = agent
            .generation
            .checked_add(1)
            .expect("ERR_GENERATION_OVERFLOW");
        self.save_agent(agent, before);
        self.get_agent(agent_id).unwrap()
    }

    pub fn checkpoint_memory(
        &mut self,
        agent_id: String,
        generation: U64,
        expected_version: U64,
        next: MemoryHead,
    ) -> bool {
        let mut agent = self.agent(&agent_id);
        Self::assert_runtime(&agent, generation.0, false);
        let current = agent.head.as_ref().map_or(0, |head| head.version.0);
        if current != expected_version.0 {
            return false;
        }
        assert_eq!(
            next.version.0,
            current.checked_add(1).expect("ERR_CHECKPOINT_OVERFLOW"),
            "ERR_CHECKPOINT_VERSION"
        );
        assert_eq!(next.key_epoch.0, agent.key_epoch, "ERR_KEY_EPOCH");
        next.manifest.validate();
        let before = env::storage_usage();
        agent.head = Some(next);
        self.save_agent(agent, before);
        Self::event(
            "memory_checkpointed",
            near_sdk::serde_json::json!({ "agentId": agent_id, "version": U64(current + 1) }),
        );
        true
    }

    pub fn get_agent(&self, agent_id: String) -> Option<AgentView> {
        self.agents.get(&agent_id).map(AgentView::from)
    }
    pub fn get_memory_head(&self, agent_id: String) -> Option<MemoryHead> {
        self.agents.get(&agent_id).and_then(|a| a.head.clone())
    }
}
