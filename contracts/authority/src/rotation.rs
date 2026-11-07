use crate::{Authority, AuthorityExt, types::*};
use near_sdk::{env, json_types::U64, near};

#[near]
impl Authority {
    /// Owner-only, immutable operation ID. Pause, revoke and epoch activation are atomic.
    pub fn begin_runtime_rotation(&mut self, request: RuntimeRotationRequest) -> RuntimeRotation {
        let mut agent = self.agent(&request.agent_id);
        Self::assert_owner(&agent);
        let key = Self::key(&request.agent_id, &request.operation_id);
        if let Some(previous) = self.rotations.get(&key) {
            assert_eq!(previous.request, request, "ERR_OPERATION_CONFLICT");
            return previous.clone();
        }
        assert_eq!(
            agent.generation, request.expected_generation.0,
            "ERR_STALE_GENERATION"
        );
        assert_eq!(agent.key_epoch, request.expected_epoch.0, "ERR_KEY_EPOCH");
        assert_eq!(
            agent.head.as_ref().map_or(0, |h| h.version.0),
            request.expected_version.0,
            "ERR_CHECKPOINT_VERSION"
        );
        // V1 deliberately rotates a single dedicated runtime. Never silently discard other grants.
        assert_eq!(agent.delegates.len(), 1, "ERR_ROTATION_SINGLE_RUNTIME");
        assert_eq!(
            agent.delegates[0].public_key, request.old_public_key,
            "ERR_ROTATION_OLD_KEY"
        );
        assert!(
            request.old_public_key != agent.owner_key,
            "ERR_OWNER_CANNOT_BE_DELEGATE"
        );
        assert!(
            request.replacement.public_key != request.old_public_key
                && request.replacement.public_key != agent.owner_key,
            "ERR_ROTATION_NEW_KEY"
        );
        assert!(request.replacement.can_checkpoint, "ERR_PERMISSION");
        assert!(
            !request.replacement.can_spend || agent.delegates[0].can_spend,
            "ERR_ROTATION_PERMISSION_EXPANSION"
        );
        let now = env::block_timestamp();
        assert!(
            request.replacement.expires_at_ns.0 > now
                && request.replacement.expires_at_ns.0
                    <= now.checked_add(30 * DAY_NS).expect("ERR_TIME_OVERFLOW"),
            "ERR_DELEGATE_EXPIRY"
        );
        assert!(
            request.recovery_commitment.len() == 64 && lower_hex(&request.recovery_commitment),
            "ERR_RECOVERY_COMMITMENT"
        );
        let before = env::storage_usage();
        agent.paused = true;
        agent.key_epoch = agent.key_epoch.checked_add(1).expect("ERR_EPOCH_OVERFLOW");
        agent.generation = agent
            .generation
            .checked_add(1)
            .expect("ERR_GENERATION_OVERFLOW");
        agent.delegates = vec![request.replacement.clone()];
        let rotation = RuntimeRotation {
            request,
            next_epoch: U64(agent.key_epoch),
            begin_generation: U64(agent.generation),
            completed: false,
        };
        self.rotations.insert(key, rotation.clone());
        self.save_agent(agent, before);
        Self::event(
            "runtime_rotation_started",
            near_sdk::serde_json::json!({"agentId":rotation.request.agent_id,"operationId":rotation.request.operation_id,"keyEpoch":rotation.next_epoch}),
        );
        rotation
    }

    /// Idempotent completion cannot reopen an agent paused after a completed rotation.
    pub fn finish_runtime_rotation(
        &mut self,
        agent_id: String,
        operation_id: String,
    ) -> RuntimeRotation {
        let mut agent = self.agent(&agent_id);
        Self::assert_owner(&agent);
        let key = Self::key(&agent_id, &operation_id);
        let mut rotation = self
            .rotations
            .get(&key)
            .expect("ERR_ROTATION_NOT_FOUND")
            .clone();
        if rotation.completed {
            return rotation;
        }
        assert!(agent.paused, "ERR_ROTATION_STATE");
        assert_eq!(agent.key_epoch, rotation.next_epoch.0, "ERR_KEY_EPOCH");
        assert_eq!(
            agent.generation, rotation.begin_generation.0,
            "ERR_STALE_GENERATION"
        );
        assert_eq!(
            agent.delegates,
            vec![rotation.request.replacement.clone()],
            "ERR_ROTATION_STATE"
        );
        assert!(
            rotation.request.replacement.expires_at_ns.0 > env::block_timestamp(),
            "ERR_DELEGATE_EXPIRED"
        );
        let before = env::storage_usage();
        agent.paused = !rotation.request.resume;
        agent.generation = agent
            .generation
            .checked_add(1)
            .expect("ERR_GENERATION_OVERFLOW");
        rotation.completed = true;
        self.rotations.insert(key, rotation.clone());
        self.save_agent(agent, before);
        Self::event(
            "runtime_rotation_finished",
            near_sdk::serde_json::json!({"agentId":agent_id,"operationId":operation_id,"keyEpoch":rotation.next_epoch}),
        );
        rotation
    }

    pub fn get_runtime_rotation(
        &self,
        agent_id: String,
        operation_id: String,
    ) -> Option<RuntimeRotation> {
        self.rotations
            .get(&Self::key(&agent_id, &operation_id))
            .cloned()
    }
}
