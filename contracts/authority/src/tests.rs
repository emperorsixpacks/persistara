use super::*;
use near_sdk::{
    AccountId, NearToken, PromiseError, PromiseResult, PublicKey,
    json_types::{U64, U128},
    test_utils::VMContextBuilder,
    testing_env,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

const OWNER: &str = "owner.testnet";
const AGENT: &str = "research.owner.testnet";
const WORKER: &str = "worker.testnet";
const NOW: u64 = 100 * DAY_NS;
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

fn pk(tag: u8) -> PublicKey {
    let mut bytes = vec![0];
    bytes.extend(vec![tag; 32]);
    bytes.try_into().unwrap()
}
fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}

fn builder(who: &str, key: u8, now: u64, deposit: u128, usage: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(account("authority.testnet"))
        .signer_account_id(account(who))
        .predecessor_account_id(account(who))
        .signer_account_pk(pk(key))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(1000))
        .storage_usage(usage);
    b
}
fn call(who: &str, key: u8, now: u64, deposit: u128) {
    testing_env!(builder(who, key, now, deposit, env::storage_usage()).build());
}
fn owner() {
    call(OWNER, 1, NOW, 0);
}
fn setup() -> Authority {
    testing_env!(builder(OWNER, 1, NOW, NEAR, 0).build());
    let mut c = Authority::new();
    c.register_agent("research".into());
    owner();
    c.configure_policy(
        AGENT.into(),
        Policy {
            max_job_amount: U128(4 * NEAR),
            daily_limit: U128(6 * NEAR),
            approved_workers: vec![account(WORKER)],
        },
    );
    call(OWNER, 1, NOW, 10 * NEAR);
    c.fund(AGENT.into());
    owner();
    c
}
fn generation(c: &Authority) -> U64 {
    c.get_agent(AGENT.into()).unwrap().generation
}
fn request(c: &Authority, id: &str, amount: u128) -> JobRequest {
    JobRequest {
        agent_id: AGENT.into(),
        generation: generation(c),
        policy_version: c.get_agent(AGENT.into()).unwrap().policy_version,
        operation_id: id.into(),
        worker: account(WORKER),
        amount: U128(amount),
        criteria_hash: "c".repeat(64),
        brief: blob(),
        quote_expires_at_ns: U64(NOW + HOUR_NS),
        delivery_deadline_ns: U64(NOW + DAY_NS),
        review_window_ns: U64(HOUR_NS),
    }
}
fn blob() -> BlobRef {
    BlobRef {
        provider: "0g".into(),
        network: "0g:16602:turbo".into(),
        object_id: format!("0x{}", "a".repeat(64)),
        ciphertext_sha256: "b".repeat(64),
        byte_length: 400,
    }
}
fn head(version: u64) -> MemoryHead {
    MemoryHead {
        version: U64(version),
        key_epoch: U64(1),
        manifest: blob(),
    }
}
fn rotation_request(c: &Authority) -> RuntimeRotationRequest {
    let agent = c.get_agent(AGENT.into()).unwrap();
    RuntimeRotationRequest {
        agent_id: AGENT.into(),
        operation_id: "rotation:one".into(),
        expected_generation: agent.generation,
        expected_epoch: agent.key_epoch,
        expected_version: U64(agent.head.as_ref().map_or(0, |h| h.version.0)),
        old_public_key: pk(2),
        replacement: Delegate {
            public_key: pk(3),
            expires_at_ns: U64(NOW + DAY_NS),
            can_checkpoint: true,
            can_spend: true,
        },
        recovery_commitment: "a".repeat(64),
        resume: true,
    }
}

#[test]
fn runtime_rotation_atomically_pauses_revokes_and_advances_one_epoch() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let request = rotation_request(&c);
    let before = c.get_agent(AGENT.into()).unwrap();
    owner();
    let r = c.begin_runtime_rotation(request.clone());
    let after = c.get_agent(AGENT.into()).unwrap();
    assert!(after.paused);
    assert_eq!(after.key_epoch.0, 2);
    assert_eq!(after.generation.0, before.generation.0 + 1);
    assert_eq!(after.delegates, vec![request.replacement]);
    assert!(!r.completed);
    assert!(after.storage_credit.0 < before.storage_credit.0);
    assert_eq!(after.available, before.available);
    assert_eq!(after.deposited, before.deposited);
    call(OWNER, 2, NOW, 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| c.checkpoint_memory(
            AGENT.into(),
            generation(&c),
            U64(0),
            head(1)
        )))
        .is_err()
    );
    owner();
    c.finish_runtime_rotation(AGENT.into(), "rotation:one".into());
    assert!(!c.get_agent(AGENT.into()).unwrap().paused);
    call(OWNER, 2, NOW, 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| c.checkpoint_memory(
            AGENT.into(),
            generation(&c),
            U64(0),
            head(1)
        )))
        .is_err()
    );
    call(OWNER, 3, NOW, 0);
    let mut next = head(1);
    next.key_epoch = U64(2);
    assert!(c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), next));
}

#[test]
fn rotation_replays_do_not_repeat_epoch_changes_or_reopen_a_paused_agent() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let request = rotation_request(&c);
    owner();
    c.begin_runtime_rotation(request.clone());
    let started = generation(&c);
    c.begin_runtime_rotation(request.clone());
    assert_eq!(generation(&c), started);
    let mut changed = request;
    changed.recovery_commitment = "b".repeat(64);
    assert!(catch_unwind(AssertUnwindSafe(|| c.begin_runtime_rotation(changed))).is_err());
    c.finish_runtime_rotation(AGENT.into(), "rotation:one".into());
    let finished = generation(&c);
    c.finish_runtime_rotation(AGENT.into(), "rotation:one".into());
    assert_eq!(generation(&c), finished);
    c.set_paused(AGENT.into(), true);
    let paused = generation(&c);
    assert!(
        c.finish_runtime_rotation(AGENT.into(), "rotation:one".into())
            .completed
    );
    assert!(c.get_agent(AGENT.into()).unwrap().paused);
    assert_eq!(generation(&c), paused);
}

#[test]
fn rotation_requires_the_registration_owner_key_for_begin_and_finish() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let request = rotation_request(&c);
    call(OWNER, 2, NOW, 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || c.begin_runtime_rotation(request.clone())
        ))
        .is_err()
    );
    owner();
    c.begin_runtime_rotation(request);
    call(OWNER, 3, NOW, 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || c.finish_runtime_rotation(AGENT.into(), "rotation:one".into())
        ))
        .is_err()
    );
}

#[test]
fn rotation_rejects_stale_generation_epoch_and_checkpoint_without_mutation() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let request = rotation_request(&c);
    owner();
    for field in 0..3 {
        let mut bad = request.clone();
        match field {
            0 => bad.expected_generation = U64(0),
            1 => bad.expected_epoch = U64(2),
            _ => bad.expected_version = U64(1),
        }
        assert!(catch_unwind(AssertUnwindSafe(|| c.begin_runtime_rotation(bad))).is_err());
        assert_eq!(c.get_agent(AGENT.into()).unwrap().key_epoch.0, 1);
        assert!(
            c.get_runtime_rotation(AGENT.into(), "rotation:one".into())
                .is_none()
        );
    }
}

#[test]
fn rotation_never_discards_other_grants_or_reuses_owner_and_old_keys() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let request = rotation_request(&c);
    owner();
    for key in [pk(1), pk(2)] {
        let mut bad = request.clone();
        bad.replacement.public_key = key;
        assert!(catch_unwind(AssertUnwindSafe(|| c.begin_runtime_rotation(bad))).is_err());
    }
    c.set_delegate(
        AGENT.into(),
        Delegate {
            public_key: pk(4),
            expires_at_ns: U64(NOW + DAY_NS),
            can_checkpoint: true,
            can_spend: false,
        },
    );
    let mut bad = rotation_request(&c);
    bad.expected_generation = generation(&c);
    assert!(catch_unwind(AssertUnwindSafe(|| c.begin_runtime_rotation(bad))).is_err());
    assert_eq!(c.get_agent(AGENT.into()).unwrap().delegates.len(), 2);
}

#[test]
fn rotation_rejects_expired_unbounded_or_expanded_replacement_permissions() {
    let mut c = setup();
    delegate(&mut c, true, false);
    let request = rotation_request(&c);
    owner();
    assert!(
        catch_unwind(AssertUnwindSafe(
            || c.begin_runtime_rotation(request.clone())
        ))
        .is_err()
    );
    for expiry in [NOW, NOW + 31 * DAY_NS] {
        let mut bad = request.clone();
        bad.replacement.can_spend = false;
        bad.replacement.expires_at_ns = U64(expiry);
        assert!(catch_unwind(AssertUnwindSafe(|| c.begin_runtime_rotation(bad))).is_err());
    }
    let mut bad = request;
    bad.replacement.can_spend = false;
    bad.replacement.can_checkpoint = false;
    assert!(catch_unwind(AssertUnwindSafe(|| c.begin_runtime_rotation(bad))).is_err());
}

#[test]
fn rotation_preserves_the_old_head_until_the_new_runtime_commits() {
    let mut c = setup();
    delegate(&mut c, true, true);
    call(OWNER, 2, NOW, 0);
    assert!(c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), head(1)));
    owner();
    let request = rotation_request(&c);
    c.begin_runtime_rotation(request);
    assert_eq!(c.get_memory_head(AGENT.into()).unwrap().version.0, 1);
    c.finish_runtime_rotation(AGENT.into(), "rotation:one".into());
    assert_eq!(c.get_memory_head(AGENT.into()).unwrap().key_epoch.0, 1);
    call(OWNER, 3, NOW, 0);
    let mut next = head(2);
    next.key_epoch = U64(2);
    assert!(c.checkpoint_memory(AGENT.into(), generation(&c), U64(1), next));
}

#[test]
fn rotation_completion_respects_expiry_intervening_owner_actions_and_pause_intent() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let mut request = rotation_request(&c);
    request.resume = false;
    owner();
    c.begin_runtime_rotation(request);
    c.finish_runtime_rotation(AGENT.into(), "rotation:one".into());
    assert!(c.get_agent(AGENT.into()).unwrap().paused);
    let mut next = rotation_request(&c);
    next.operation_id = "rotation:two".into();
    next.old_public_key = pk(3);
    next.replacement.public_key = pk(4);
    c.begin_runtime_rotation(next);
    c.set_paused(AGENT.into(), true);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || c.finish_runtime_rotation(AGENT.into(), "rotation:two".into())
        ))
        .is_err()
    );
    assert!(c.get_agent(AGENT.into()).unwrap().paused);
}

#[test]
fn expired_or_superseded_rotation_cannot_finish_or_rollback_a_newer_epoch() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let request = rotation_request(&c);
    owner();
    c.begin_runtime_rotation(request);
    call(OWNER, 1, NOW + 2 * DAY_NS, 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || c.finish_runtime_rotation(AGENT.into(), "rotation:one".into())
        ))
        .is_err()
    );
    owner();
    let mut next = rotation_request(&c);
    next.operation_id = "rotation:two".into();
    next.old_public_key = pk(3);
    next.replacement.public_key = pk(4);
    c.begin_runtime_rotation(next);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || c.finish_runtime_rotation(AGENT.into(), "rotation:one".into())
        ))
        .is_err()
    );
    assert_eq!(c.get_agent(AGENT.into()).unwrap().key_epoch.0, 3);
}
fn delegate(c: &mut Authority, checkpoint: bool, spend: bool) {
    owner();
    c.set_delegate(
        AGENT.into(),
        Delegate {
            public_key: pk(2),
            expires_at_ns: U64(NOW + DAY_NS),
            can_checkpoint: checkpoint,
            can_spend: spend,
        },
    );
}
fn reject(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
}
fn conserved(c: &Authority) {
    let a = c.get_agent(AGENT.into()).unwrap();
    assert_eq!(
        a.deposited.0,
        a.available.0 + a.reserved.0 + a.pending.0 + a.paid.0 + a.withdrawn.0
    );
}
#[allow(deprecated)]
fn callback(success: bool) {
    let ctx = builder("authority.testnet", 1, NOW, 0, env::storage_usage()).build();
    near_sdk::test_utils::testing_env_with_promise_results(
        ctx,
        if success {
            PromiseResult::Successful(vec![])
        } else {
            PromiseResult::Failed
        },
    );
}
fn delivered(c: &mut Authority) {
    owner();
    c.create_job(request(c, "job:one", 2 * NEAR));
    call(WORKER, 3, NOW, 0);
    c.deliver(AGENT.into(), "job:one".into(), blob());
    owner();
}

#[test]
fn agent_names_are_owner_namespaced() {
    let mut c = setup();
    call("another.testnet", 4, NOW, NEAR);
    let other = c.register_agent("research".into());
    assert_eq!(other.id, "research.another.testnet");
    assert_eq!(c.get_agent(AGENT.into()).unwrap().owner, account(OWNER));
}

#[test]
fn agent_ids_are_valid_owner_subaccount_names_only() {
    let mut c = setup();
    for bad in [
        "",
        "a",
        "Research",
        "research.sub",
        "-lead",
        "trail-",
        "_lead",
        "trail_",
        "dou--ble",
        "a-_b",
        "sp ace",
        "colon:name",
        "emoji\u{1f600}",
        "with/slash",
        "name@x",
        &"a".repeat(33),
    ] {
        call(OWNER, 3, NOW, NEAR);
        let name = bad.to_string();
        reject(|| {
            c.register_agent(name.clone());
        });
    }
    for good in [
        "ab",
        "a1",
        "researcher",
        "re-search",
        "re_search",
        "a-b_c9",
        &"a".repeat(32),
    ] {
        call(OWNER, 3, NOW, NEAR);
        assert_eq!(
            c.register_agent(good.into()).id,
            format!("{good}.owner.testnet")
        );
    }
    // A long owner makes `name.owner` exceed NEAR's 64-character account limit, so it is refused rather than truncated.
    let long_owner = format!("{}.testnet", "o".repeat(56));
    call(&long_owner, 3, NOW, NEAR);
    reject(|| {
        c.register_agent("research".into());
    });
}

#[test]
fn delegate_cannot_use_owner_methods_or_another_agents_identity() {
    let mut c = setup();
    delegate(&mut c, true, true);
    call(OWNER, 1, NOW, NEAR);
    c.register_agent("other".into());
    call(OWNER, 2, NOW, 0);
    reject(|| {
        c.set_paused(AGENT.into(), true);
    });
    reject(|| {
        c.checkpoint_memory("other.owner.testnet".into(), U64(1), U64(0), head(1));
    });
    conserved(&c);
}

#[test]
fn checkpoint_cas_prevents_lost_updates() {
    let mut c = setup();
    delegate(&mut c, true, false);
    call(OWNER, 2, NOW, 0);
    assert!(c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), head(1)));
    assert!(!c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), head(1)));
    assert_eq!(c.get_memory_head(AGENT.into()).unwrap().version.0, 1);
}

#[test]
fn revocation_fences_stale_generations_and_removed_keys() {
    let mut c = setup();
    delegate(&mut c, true, true);
    let stale = generation(&c);
    owner();
    c.revoke_delegate(AGENT.into(), pk(2));
    call(OWNER, 2, NOW, 0);
    reject(|| {
        c.checkpoint_memory(AGENT.into(), stale, U64(0), head(1));
    });
    reject(|| {
        c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), head(1));
    });
    assert!(c.get_memory_head(AGENT.into()).is_none());
}

#[test]
fn expired_or_insufficient_permission_delegates_cannot_act() {
    let mut c = setup();
    delegate(&mut c, true, false);
    call(OWNER, 2, NOW, 0);
    reject(|| {
        c.create_job(request(&c, "job:bad", NEAR));
    });
    call(OWNER, 2, NOW + DAY_NS, 0);
    reject(|| {
        c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), head(1));
    });
}

#[test]
fn pause_blocks_new_reservations_and_memory_heads() {
    let mut c = setup();
    c.set_paused(AGENT.into(), true);
    reject(|| {
        c.create_job(request(&c, "job:bad", NEAR));
    });
    reject(|| {
        c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), head(1));
    });
    conserved(&c);
}

#[test]
fn key_epoch_and_reference_validation_are_enforced() {
    let mut c = setup();
    c.rotate_memory_epoch(AGENT.into(), U64(2));
    reject(|| {
        c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), head(1));
    });
    let mut next = head(1);
    next.key_epoch = U64(2);
    next.manifest.object_id = "not-a-root".into();
    reject(|| {
        c.checkpoint_memory(AGENT.into(), generation(&c), U64(0), next);
    });
}

#[test]
fn a_proxy_cannot_reuse_the_original_signers_authority() {
    let mut c = setup();
    let mut ctx = builder(OWNER, 1, NOW, 0, env::storage_usage());
    ctx.predecessor_account_id(account("proxy.testnet"));
    testing_env!(ctx.build());
    reject(|| {
        c.set_paused(AGENT.into(), true);
    });
}

#[test]
fn duplicate_reservation_is_idempotent_but_changed_payload_fails() {
    let mut c = setup();
    let r = request(&c, "job:one", 2 * NEAR);
    c.create_job(r.clone());
    c.create_job(r.clone());
    let mut changed = r;
    changed.amount = U128(3 * NEAR);
    reject(|| {
        c.create_job(changed);
    });
    let a = c.get_agent(AGENT.into()).unwrap();
    assert_eq!(a.reserved.0, 2 * NEAR);
    assert_eq!(a.allocated.0, 2 * NEAR);
    conserved(&c);
}

#[test]
fn outstanding_reservations_count_against_daily_budget() {
    let mut c = setup();
    c.create_job(request(&c, "job:one", 4 * NEAR));
    reject(|| {
        c.create_job(request(&c, "job:two", 3 * NEAR));
    });
    assert_eq!(c.get_agent(AGENT.into()).unwrap().available.0, 6 * NEAR);
    conserved(&c);
}

#[test]
fn per_job_worker_quote_and_balance_constraints_are_checked() {
    let mut c = setup();
    reject(|| {
        c.create_job(request(&c, "job:large", 5 * NEAR));
    });
    let mut r = request(&c, "job:worker", NEAR);
    r.worker = account("bad.testnet");
    reject(|| {
        c.create_job(r);
    });
    let mut r = request(&c, "job:expired", NEAR);
    r.quote_expires_at_ns = U64(NOW);
    reject(|| {
        c.create_job(r);
    });
    c.configure_policy(
        AGENT.into(),
        Policy {
            max_job_amount: U128(20 * NEAR),
            daily_limit: U128(20 * NEAR),
            approved_workers: vec![account(WORKER)],
        },
    );
    reject(|| {
        c.create_job(request(&c, "job:unfunded", 11 * NEAR));
    });
    conserved(&c);
}

#[test]
fn cancellation_returns_balance_without_replenishing_daily_allocation() {
    let mut c = setup();
    c.create_job(request(&c, "job:one", 2 * NEAR));
    c.cancel_job(AGENT.into(), "job:one".into());
    c.cancel_job(AGENT.into(), "job:one".into());
    let a = c.get_agent(AGENT.into()).unwrap();
    assert_eq!(a.available.0, 10 * NEAR);
    assert_eq!(a.allocated.0, 2 * NEAR);
    assert_eq!(a.storage_reserved.0, 0);
    c.create_job(request(&c, "job:two", 4 * NEAR));
    reject(|| {
        c.create_job(request(&c, "job:three", NEAR));
    });
    conserved(&c);
}

#[test]
fn delivery_requires_the_worker_and_cannot_replace_an_artifact() {
    let mut c = setup();
    c.create_job(request(&c, "job:one", NEAR));
    reject(|| {
        c.deliver(AGENT.into(), "job:one".into(), blob());
    });
    call(WORKER, 3, NOW, 0);
    c.deliver(AGENT.into(), "job:one".into(), blob());
    c.deliver(AGENT.into(), "job:one".into(), blob());
    let mut different = blob();
    different.ciphertext_sha256 = "d".repeat(64);
    reject(|| {
        c.deliver(AGENT.into(), "job:one".into(), different);
    });
    conserved(&c);
}

#[test]
fn a_funded_job_prepays_worker_delivery_storage() {
    let mut c = setup();
    c.create_job(request(&c, "job:one", NEAR));
    let mut a = c.agent(AGENT);
    c.storage_credits_total -= a.storage_credit;
    a.storage_credit = 0;
    c.agents.insert(AGENT.into(), a);
    c.agents.flush();
    call(WORKER, 3, NOW, 0);
    c.deliver(AGENT.into(), "job:one".into(), blob());
    let a = c.get_agent(AGENT.into()).unwrap();
    assert!(a.storage_credit.0 > 0);
    assert_eq!(a.storage_reserved.0, 0);
    conserved(&c);
}

#[test]
fn payout_is_pending_until_callback_and_duplicate_callbacks_do_not_pay_twice() {
    let mut c = setup();
    delivered(&mut c);
    c.accept_job(
        AGENT.into(),
        "job:one".into(),
        generation(&c),
        blob().ciphertext_sha256,
    );
    assert_eq!(c.get_agent(AGENT.into()).unwrap().pending.0, 2 * NEAR);
    conserved(&c);
    callback(true);
    assert!(c.on_payout(AGENT.into(), "job:one".into(), U64(1), Ok(())));
    callback(true);
    assert!(!c.on_payout(AGENT.into(), "job:one".into(), U64(1), Ok(())));
    assert_eq!(c.get_agent(AGENT.into()).unwrap().paid.0, 2 * NEAR);
    conserved(&c);
}

#[test]
fn failed_payout_is_retryable_and_old_attempt_callbacks_are_fenced() {
    let mut c = setup();
    delivered(&mut c);
    c.accept_job(
        AGENT.into(),
        "job:one".into(),
        generation(&c),
        blob().ciphertext_sha256,
    );
    callback(false);
    c.on_payout(
        AGENT.into(),
        "job:one".into(),
        U64(1),
        Err(PromiseError::Failed),
    );
    assert_eq!(
        c.get_job(AGENT.into(), "job:one".into()).unwrap().status,
        JobStatus::PayoutFailed
    );
    call("anyone.testnet", 9, NOW, 0);
    c.retry_payout(AGENT.into(), "job:one".into());
    c.retry_payout(AGENT.into(), "job:one".into());
    callback(true);
    assert!(!c.on_payout(AGENT.into(), "job:one".into(), U64(1), Ok(())));
    callback(true);
    assert!(c.on_payout(AGENT.into(), "job:one".into(), U64(2), Ok(())));
    assert_eq!(c.get_agent(AGENT.into()).unwrap().paid.0, 2 * NEAR);
    conserved(&c);
}

#[test]
fn external_callers_cannot_forge_payout_callbacks() {
    let mut c = setup();
    delivered(&mut c);
    c.accept_job(
        AGENT.into(),
        "job:one".into(),
        generation(&c),
        blob().ciphertext_sha256,
    );
    call("attacker.testnet", 9, NOW, 0);
    reject(|| {
        c.on_payout(AGENT.into(), "job:one".into(), U64(1), Ok(()));
    });
    conserved(&c);
}

#[test]
fn an_undelivered_job_expires_back_to_the_treasury() {
    let mut c = setup();
    c.create_job(request(&c, "job:one", 2 * NEAR));
    call("anyone.testnet", 9, NOW + 2 * DAY_NS, 0);
    c.advance_timeout(AGENT.into(), "job:one".into());
    assert_eq!(c.get_agent(AGENT.into()).unwrap().available.0, 10 * NEAR);
    conserved(&c);
}

#[test]
fn pause_does_not_block_an_existing_worker_obligation_after_review() {
    let mut c = setup();
    delivered(&mut c);
    c.set_paused(AGENT.into(), true);
    call("anyone.testnet", 9, NOW + 2 * HOUR_NS, 0);
    c.advance_timeout(AGENT.into(), "job:one".into());
    assert_eq!(
        c.get_job(AGENT.into(), "job:one".into()).unwrap().status,
        JobStatus::PayoutPending
    );
    conserved(&c);
}

#[test]
fn owner_mediated_disputes_have_a_bounded_refund_timeout() {
    let mut c = setup();
    delivered(&mut c);
    c.dispute_job(AGENT.into(), "job:one".into());
    call("anyone.testnet", 9, NOW + 8 * DAY_NS, 0);
    c.advance_timeout(AGENT.into(), "job:one".into());
    assert_eq!(
        c.get_job(AGENT.into(), "job:one".into()).unwrap().status,
        JobStatus::Refunded
    );
    conserved(&c);
}

#[test]
fn withdrawal_failure_restores_available_funds_and_retry_is_deduplicated() {
    let mut c = setup();
    c.withdraw_funds(AGENT.into(), "withdraw:one".into(), U128(3 * NEAR));
    c.withdraw_funds(AGENT.into(), "withdraw:one".into(), U128(3 * NEAR));
    assert_eq!(c.get_agent(AGENT.into()).unwrap().pending.0, 3 * NEAR);
    callback(false);
    c.on_withdrawal(
        AGENT.into(),
        "withdraw:one".into(),
        U64(1),
        Err(PromiseError::Failed),
    );
    assert_eq!(c.get_agent(AGENT.into()).unwrap().available.0, 10 * NEAR);
    owner();
    c.retry_withdrawal(AGENT.into(), "withdraw:one".into());
    c.retry_withdrawal(AGENT.into(), "withdraw:one".into());
    callback(true);
    c.on_withdrawal(AGENT.into(), "withdraw:one".into(), U64(2), Ok(()));
    callback(true);
    assert!(!c.on_withdrawal(AGENT.into(), "withdraw:one".into(), U64(2), Ok(())));
    assert_eq!(c.get_agent(AGENT.into()).unwrap().withdrawn.0, 3 * NEAR);
    conserved(&c);
}

#[test]
fn new_budget_window_does_not_erase_old_reservations() {
    let mut c = setup();
    c.create_job(request(&c, "job:one", 4 * NEAR));
    let mut next = request(&c, "job:two", 4 * NEAR);
    call(OWNER, 1, NOW + DAY_NS, 0);
    next.quote_expires_at_ns = U64(NOW + DAY_NS + HOUR_NS);
    next.delivery_deadline_ns = U64(NOW + 2 * DAY_NS);
    c.create_job(next);
    let a = c.get_agent(AGENT.into()).unwrap();
    assert_eq!(a.reserved.0, 8 * NEAR);
    assert_eq!(a.allocated.0, 4 * NEAR);
    conserved(&c);
}

#[test]
fn acceptance_requires_the_exact_reviewed_artifact_digest() {
    let mut c = setup();
    delivered(&mut c);
    reject(|| {
        c.accept_job(
            AGENT.into(),
            "job:one".into(),
            generation(&c),
            "d".repeat(64),
        );
    });
    assert_eq!(
        c.get_job(AGENT.into(), "job:one".into()).unwrap().status,
        JobStatus::Delivered
    );
    assert_eq!(c.get_agent(AGENT.into()).unwrap().pending.0, 0);
    conserved(&c);
}

#[test]
fn policy_reconfiguration_preserves_allocations_and_fences_old_quotes() {
    let mut c = setup();
    c.create_job(request(&c, "job:one", 4 * NEAR));
    let old = request(&c, "job:stale", NEAR);
    c.configure_policy(
        AGENT.into(),
        Policy {
            max_job_amount: U128(4 * NEAR),
            daily_limit: U128(6 * NEAR),
            approved_workers: vec![account(WORKER)],
        },
    );
    reject(|| {
        c.create_job(old);
    });
    reject(|| {
        c.create_job(request(&c, "job:over", 3 * NEAR));
    });
    assert_eq!(c.get_agent(AGENT.into()).unwrap().allocated.0, 4 * NEAR);
    conserved(&c);
}

#[test]
fn funding_overflow_rejects_before_mutating_any_balance() {
    let mut c = setup();
    // Keep the VM's account balance + attached deposit in range, while the
    // already-recorded treasury deposit plus this amount must overflow.
    let mut ctx = builder(OWNER, 1, NOW, u128::MAX, env::storage_usage());
    ctx.account_balance(NearToken::from_yoctonear(0));
    testing_env!(ctx.build());
    reject(|| {
        c.fund(AGENT.into());
    });
    assert_eq!(c.get_agent(AGENT.into()).unwrap().deposited.0, 10 * NEAR);
    conserved(&c);
}
