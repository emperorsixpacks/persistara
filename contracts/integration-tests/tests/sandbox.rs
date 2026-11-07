//! Real WASM on a disposable local NEAR chain. Keys here are public test fixtures.
use anyhow::Result;
use near_workspaces::{
    Account, Contract, Worker,
    network::Sandbox,
    types::{AccessKey, KeyType, NearToken, SecretKey},
};
use serde_json::{Value, json};

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const HOUR: u64 = 3_600_000_000_000;

fn blob(tag: &str) -> Value {
    json!({"provider":"0g","network":"0g:16602:turbo","objectId":format!("0x{}",tag.repeat(64)),"ciphertextSha256":tag.repeat(64),"byteLength":100})
}

async fn fixture(
    storage: NearToken,
) -> Result<(Worker<Sandbox>, Contract, Account, Account, String)> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/near/persistara_authority/persistara_authority.wasm"
    ))?;
    let contract = worker.dev_deploy(&wasm).await?;
    contract
        .call("new")
        .args_json(json!({}))
        .transact()
        .await?
        .into_result()?;
    let owner = worker.dev_create_account().await?;
    let specialist = owner
        .create_subaccount("specialist")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let id = format!("{}:research", owner.id());
    owner
        .call(contract.id(), "register_agent")
        .args_json(json!({"name":"research"}))
        .deposit(storage)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    owner.call(contract.id(),"configure_policy").args_json(json!({"agent_id":id,"policy":{"maxJobAmount":(4*NEAR).to_string(),"dailyLimit":(6*NEAR).to_string(),"approvedWorkers":[specialist.id()]}})).max_gas().transact().await?.into_result()?;
    owner
        .call(contract.id(), "fund")
        .args_json(json!({"agent_id":id}))
        .deposit(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    Ok((worker, contract, owner, specialist, id))
}

async fn agent(contract: &Contract, id: &str) -> Result<Value> {
    Ok(contract
        .view("get_agent")
        .args_json(json!({"agent_id":id}))
        .await?
        .json()?)
}

async fn job(contract: &Contract, id: &str, op: &str) -> Result<Value> {
    Ok(contract
        .view("get_job")
        .args_json(json!({"agent_id":id,"operation_id":op}))
        .await?
        .json()?)
}

async fn settle_gas_refunds(worker: &Worker<Sandbox>) -> Result<()> {
    // NEAR gas refunds can arrive after a transaction's reported execution
    // result. Let those receipts settle before measuring only a worker payout.
    let target = worker.view_block().await?.height() + 4;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while worker.view_block().await?.height() < target {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "sandbox stopped producing blocks"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}

async fn wait_for_finalized_setup(contract: &Contract, id: &str) -> Result<()> {
    // near-workspaces transactions/read defaults are optimistic. Application
    // clients intentionally read final state, so onboarding must be final first.
    let expected = agent(contract, id).await?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while contract
        .view("get_agent")
        .args_json(json!({"agent_id":id}))
        .finality(near_workspaces::types::Finality::Final)
        .await?
        .json::<Value>()?
        != expected
    {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "sandbox setup did not finalize"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}

fn request(
    id: &str,
    op: &str,
    specialist: &Account,
    amount: u128,
    generation: &Value,
    now: u64,
) -> Value {
    json!({"agentId":id,"operationId":op,"generation":generation,"policyVersion":"1","worker":specialist.id(),"amount":amount.to_string(),"criteriaHash":"a".repeat(64),"brief":blob("b"),"quoteExpiresAtNs":(now+HOUR).to_string(),"deliveryDeadlineNs":(now+2*HOUR).to_string(),"reviewWindowNs":HOUR.to_string()})
}

fn assert_conservation(a: &Value) {
    let amount = |key| a[key].as_str().unwrap().parse::<u128>().unwrap();
    assert_eq!(
        amount("deposited"),
        ["available", "reserved", "pending", "paid", "withdrawn"]
            .into_iter()
            .map(amount)
            .sum::<u128>()
    );
}

#[tokio::test]
async fn scoped_keys_checkpoint_budgets_and_real_payout() -> Result<()> {
    let (worker, contract, owner, specialist, id) = fixture(NearToken::from_near(1)).await?;
    let key = SecretKey::from_seed(KeyType::ED25519, "persistara-runtime-fixture");
    owner
        .batch(owner.id())
        .add_key(
            key.public_key(),
            AccessKey::function_call_access(
                contract.id(),
                &["checkpoint_memory", "create_job", "accept_job"],
                Some(NearToken::from_near(5)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let runtime = Account::from_secret_key(owner.id().clone(), key.clone(), &worker);
    let now = worker.view_block().await?.timestamp();
    owner.call(contract.id(),"set_delegate").args_json(json!({"agent_id":id,"delegate":{"publicKey":key.public_key().to_string(),"expiresAtNs":(now+24*HOUR).to_string(),"canCheckpoint":true,"canSpend":true}})).max_gas().transact().await?.into_result()?;
    let generation = agent(&contract, &id).await?["generation"].clone();
    let checkpoint = json!({"agent_id":id,"generation":generation,"expected_version":"0","next":{"version":"1","keyEpoch":"1","manifest":blob("c")}});
    let first: bool = runtime
        .call(contract.id(), "checkpoint_memory")
        .args_json(checkpoint.clone())
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(first);
    let stale: bool = runtime
        .call(contract.id(), "checkpoint_memory")
        .args_json(checkpoint.clone())
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert!(!stale);
    let denied = runtime
        .call(contract.id(), "set_paused")
        .args_json(json!({"agent_id":id,"paused":true}))
        .transact()
        .await;
    assert!(
        denied.is_err(),
        "protocol must reject a method outside the access-key scope"
    );
    assert!(format!("{:?}", denied.unwrap_err()).contains("MethodNameMismatch"));
    let now = worker.view_block().await?.timestamp();
    let first_request = request(&id, "first", &specialist, 2 * NEAR, &generation, now);
    runtime
        .call(contract.id(), "create_job")
        .args_json(json!({"request":first_request}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    runtime
        .call(contract.id(), "create_job")
        .args_json(json!({"request":first_request}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    runtime
        .call(contract.id(), "create_job")
        .args_json(json!({"request":request(&id,"second",&specialist,4*NEAR,&generation,now)}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let before = agent(&contract, &id).await?;
    assert_conservation(&before);
    let denied = runtime
        .call(contract.id(), "create_job")
        .args_json(json!({"request":request(&id,"over-budget",&specialist,NEAR,&generation,now)}))
        .max_gas()
        .transact()
        .await?
        .into_result();
    assert!(format!("{:?}", denied.unwrap_err()).contains("ERR_DAILY_LIMIT"));
    assert_eq!(
        agent(&contract, &id).await?,
        before,
        "failed transaction must roll back accounting"
    );
    assert!(job(&contract, &id, "over-budget").await?.is_null());
    specialist
        .call(contract.id(), "deliver")
        .args_json(json!({"agent_id":id,"operation_id":"first","result":blob("d")}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    settle_gas_refunds(&worker).await?;
    let balance = specialist.view_account().await?.balance.as_yoctonear();
    let acceptance = json!({"agent_id":id,"operation_id":"first","generation":generation,"expected_result_digest":"d".repeat(64)});
    let initial: Value = owner
        .call(contract.id(), "accept_job")
        .args_json(acceptance.clone())
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(
        initial["status"], "payout_pending",
        "initial receipt is not final settlement"
    );
    assert_eq!(job(&contract, &id, "first").await?["status"], "paid");
    assert_eq!(
        specialist.view_account().await?.balance.as_yoctonear(),
        balance + 2 * NEAR
    );
    owner
        .call(contract.id(), "accept_job")
        .args_json(acceptance)
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        specialist.view_account().await?.balance.as_yoctonear(),
        balance + 2 * NEAR,
        "duplicate acceptance cannot pay twice"
    );
    let forged = owner
        .call(contract.id(), "on_payout")
        .args_json(json!({"agent_id":id,"operation_id":"first","attempt":"1"}))
        .max_gas()
        .transact()
        .await?
        .into_result();
    assert!(forged.is_err());
    owner
        .call(contract.id(), "revoke_delegate")
        .args_json(json!({"agent_id":id,"public_key":key.public_key().to_string()}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let mut revoked_checkpoint = checkpoint;
    revoked_checkpoint["generation"] = agent(&contract, &id).await?["generation"].clone();
    let revoked = runtime
        .call(contract.id(), "checkpoint_memory")
        .args_json(revoked_checkpoint)
        .max_gas()
        .transact()
        .await?
        .into_result();
    assert!(format!("{:?}", revoked.unwrap_err()).contains("ERR_UNAUTHORIZED_KEY"));
    owner
        .call(contract.id(), "cancel_job")
        .args_json(json!({"agent_id":id,"operation_id":"second"}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let a = agent(&contract, &id).await?;
    assert_conservation(&a);
    assert_eq!(a["paid"], (2 * NEAR).to_string());
    assert_eq!(a["available"], (8 * NEAR).to_string());
    assert_eq!(
        a["allocated"],
        (6 * NEAR).to_string(),
        "refunds preserve daily allocation"
    );
    owner
        .call(contract.id(), "withdraw_funds")
        .args_json(json!({"agent_id":id,"operation_id":"withdraw-1","amount":NEAR.to_string()}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let a = agent(&contract, &id).await?;
    assert_conservation(&a);
    assert_eq!(a["withdrawn"], NEAR.to_string());
    assert_eq!(a["pending"], "0");
    Ok(())
}

#[tokio::test]
async fn failed_transfer_retries_once_and_storage_failure_rolls_back() -> Result<()> {
    let (worker, contract, owner, specialist, id) = fixture(NearToken::from_millinear(100)).await?;
    let generation = agent(&contract, &id).await?["generation"].clone();
    let now = worker.view_block().await?.timestamp();
    let first = request(&id, "failed-payout", &specialist, NEAR, &generation, now);
    owner
        .call(contract.id(), "create_job")
        .args_json(json!({"request":first}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let mut storage_rejected = false;
    for n in 0..5 {
        let op = format!("storage-{n}");
        let before = agent(&contract, &id).await?;
        let outcome = owner
            .call(contract.id(), "create_job")
            .args_json(json!({"request":request(&id,&op,&specialist,NEAR,&generation,now)}))
            .max_gas()
            .transact()
            .await?
            .into_result();
        if let Err(error) = outcome {
            assert!(
                format!("{error:?}").contains("ERR_JOB_STORAGE_RESERVE")
                    || format!("{error:?}").contains("ERR_STORAGE_CREDIT")
            );
            assert_eq!(agent(&contract, &id).await?, before);
            assert!(job(&contract, &id, &op).await?.is_null());
            storage_rejected = true;
            break;
        }
    }
    assert!(
        storage_rejected,
        "bounded storage must reject before the daily budget is exhausted"
    );
    specialist
        .call(contract.id(), "deliver")
        .args_json(json!({"agent_id":id,"operation_id":"failed-payout","result":blob("e")}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    specialist
        .batch(specialist.id())
        .delete_account(owner.id())
        .transact()
        .await?
        .into_result()?;
    owner.call(contract.id(),"accept_job").args_json(json!({"agent_id":id,"operation_id":"failed-payout","generation":generation,"expected_result_digest":"e".repeat(64)})).max_gas().transact().await?.into_result()?;
    assert_eq!(
        job(&contract, &id, "failed-payout").await?["status"],
        "payout_failed"
    );
    assert_conservation(&agent(&contract, &id).await?);
    let recreated = owner
        .create_subaccount("specialist")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let balance = recreated.view_account().await?.balance.as_yoctonear();
    owner
        .call(contract.id(), "retry_payout")
        .args_json(json!({"agent_id":id,"operation_id":"failed-payout"}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        job(&contract, &id, "failed-payout").await?["status"],
        "paid"
    );
    assert_eq!(
        recreated.view_account().await?.balance.as_yoctonear(),
        balance + NEAR
    );
    owner
        .call(contract.id(), "retry_payout")
        .args_json(json!({"agent_id":id,"operation_id":"failed-payout"}))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    assert_eq!(
        recreated.view_account().await?.balance.as_yoctonear(),
        balance + NEAR
    );
    assert_conservation(&agent(&contract, &id).await?);
    Ok(())
}

fn run_application_fixture(input: &Value) -> Result<Value> {
    run_node_fixture("near-client-sandbox", input)
}

fn run_node_fixture(name: &str, input: &Value) -> Result<Value> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut child = Command::new(root.join("node_modules/node/bin/node"))
        .arg(root.join(format!("dist/tests/fixtures/{name}.js")))
        .current_dir(&root)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .unwrap()
        .write_all(&serde_json::to_vec(input)?)?;
    let output = child.wait_with_output()?;
    // The fixture prints only sanitized status; never include its input/key material.
    let expected_exit = input
        .get("expectedExit")
        .and_then(Value::as_i64)
        .unwrap_or(0) as i32;
    anyhow::ensure!(
        output.status.code() == Some(expected_exit),
        "application fixture failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    if expected_exit != 0 {
        return Ok(json!({"exitCode": expected_exit}));
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

// NEP-413's specified Borsh payload, hashed and signed entirely by the external Rust wallet.
// Neither owner nor specialist wallet secrets enter the Node application process.
fn specialist_message_signature(account: &Account, request: &Value) -> Result<String> {
    use sha2::{Digest, Sha256};
    let message = request["message"].as_str().unwrap();
    let recipient = request["envelope"]["recipient"].as_str().unwrap();
    anyhow::ensure!(recipient.starts_with("persistara-specialist:v1:"));
    let nonce = request["nonceBytes"].as_array().unwrap();
    anyhow::ensure!(nonce.len() == 32);
    let mut bytes = 2_147_484_061u32.to_le_bytes().to_vec();
    bytes.extend_from_slice(&(message.len() as u32).to_le_bytes());
    bytes.extend_from_slice(message.as_bytes());
    for value in nonce {
        bytes.push(value.as_u64().unwrap() as u8);
    }
    bytes.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    bytes.extend_from_slice(recipient.as_bytes());
    bytes.push(0); // callback_url: None
    let key: near_crypto::SecretKey = account.secret_key().to_string().parse()?;
    Ok(key.sign(&Sha256::digest(bytes)).to_string())
}

#[tokio::test]
async fn signed_specialist_commission_recovers_and_pays_once_without_wallet_keys() -> Result<()> {
    use near_workspaces::types::Gas;
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let (worker, contract, owner, specialist, id) = fixture(NearToken::from_near(1)).await?;
    let key = SecretKey::from_seed(KeyType::ED25519, "commission-runtime-fixture");
    owner
        .batch(owner.id())
        .add_key(
            key.public_key(),
            AccessKey::function_call_access(
                contract.id(),
                &["checkpoint_memory", "create_job", "accept_job"],
                Some(NearToken::from_yoctonear(NEAR / 4)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let now = worker.view_block().await?.timestamp();
    owner.call(contract.id(), "set_delegate").args_json(json!({"agent_id":id,"delegate":{"publicKey":key.public_key().to_string(),"expiresAtNs":(now+24*HOUR).to_string(),"canCheckpoint":true,"canSpend":true}})).max_gas().transact().await?.into_result()?;
    wait_for_finalized_setup(&contract, &id).await?;
    let directory = std::env::temp_dir().join(format!(
        "persistara-commission-{}-{now}",
        std::process::id()
    ));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let mut input = json!({"directory":directory,"phase":"profile","rpcUrl":worker.rpc_addr(),"contractId":contract.id(),"signerId":owner.id(),"agentId":id,"publicKey":key.public_key().to_string(),"workerId":specialist.id(),"workerPublicKey":specialist.secret_key().public_key().to_string()});
    let result: Result<()> = async {
        let profile = run_node_fixture("commerce-sandbox", &input)?;
        input["signature"] = json!(specialist_message_signature(&specialist, &profile)?);
        input["phase"] = json!("initialize");
        input["runtimeSecretKey"] = json!(key.to_string());
        let created = run_node_fixture("commerce-sandbox", &input)?;
        let commission = created["commissionId"].as_str().unwrap().to_owned();
        input.as_object_mut().unwrap().remove("runtimeSecretKey");
        input.as_object_mut().unwrap().remove("signature");
        input["phase"] = json!("quote");
        let quote = run_node_fixture("commerce-sandbox", &input)?;
        input["signature"] = json!(specialist_message_signature(&specialist, &quote)?);
        assert_eq!(
            run_node_fixture("commerce-sandbox", &input)?["state"],
            "quoted"
        );
        input.as_object_mut().unwrap().remove("signature");
        input["phase"] = json!("reserve-crash");
        input["expectedExit"] = json!(74);
        assert_eq!(
            run_node_fixture("commerce-sandbox", &input)?["exitCode"],
            74
        );
        input.as_object_mut().unwrap().remove("expectedExit");
        input["phase"] = json!("observe-reservation");
        assert_eq!(
            run_node_fixture("commerce-sandbox", &input)?["state"],
            "funded"
        );
        input["phase"] = json!("fulfill");
        run_node_fixture("commerce-sandbox", &input)?;
        input["phase"] = json!("prepare-delivery");
        let request = run_node_fixture("commerce-sandbox", &input)?["walletRequest"].clone();
        assert_eq!(request["worker"], specialist.id().as_str());
        assert_eq!(request["contractId"], contract.id().as_str());
        assert_eq!(request["method"], "deliver");
        specialist
            .call(contract.id(), "deliver")
            .args_json(request["args"].clone())
            .gas(Gas::from_tgas(100))
            .transact()
            .await?
            .into_result()?;
        let expected_delivery = request["args"]["result"].clone();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let current: Value = contract
                .view("get_job")
                .args_json(json!({"agent_id":id,"operation_id":commission}))
                .finality(near_workspaces::types::Finality::Final)
                .await?
                .json()?;
            if current["result"] == expected_delivery {
                break;
            }
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "specialist delivery did not finalize"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        input["phase"] = json!("receipt");
        let receipt = run_node_fixture("commerce-sandbox", &input)?;
        input["signature"] = json!(specialist_message_signature(&specialist, &receipt)?);
        assert_eq!(
            run_node_fixture("commerce-sandbox", &input)?["delivered"],
            true
        );
        input.as_object_mut().unwrap().remove("signature");
        input["phase"] = json!("inspect");
        let inspected = run_node_fixture("commerce-sandbox", &input)?;
        assert_eq!(inspected["deliveryVerified"], true);
        settle_gas_refunds(&worker).await?;
        let balance = specialist.view_account().await?.balance.as_yoctonear();
        input["phase"] = json!("settle-crash");
        input["expectedExit"] = json!(75);
        assert_eq!(
            run_node_fixture("commerce-sandbox", &input)?["exitCode"],
            75
        );
        input.as_object_mut().unwrap().remove("expectedExit");
        input["phase"] = json!("observe-payment");
        let paid = run_node_fixture("commerce-sandbox", &input)?;
        assert_eq!(paid["state"], "paid");
        assert_eq!(paid["payoutAttempt"], "1");
        assert_eq!(paid["uploadCalls"], 6);
        assert_eq!(paid["sourceCount"], 2);
        std::fs::remove_file(directory.join("buyer/runtime.key"))?;
        assert_eq!(
            run_node_fixture("commerce-sandbox", &input)?["artifactDigest"],
            paid["artifactDigest"]
        );
        settle_gas_refunds(&worker).await?;
        assert_eq!(
            specialist.view_account().await?.balance.as_yoctonear(),
            balance + NEAR / 100
        );
        let final_job = job(&contract, &id, &commission).await?;
        assert_eq!(final_job["status"], "paid");
        assert_eq!(final_job["payoutAttempt"], "1");
        assert_conservation(&agent(&contract, &id).await?);
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(directory.join("recovery"))?;
        input["phase"] = json!("prepare-kit");
        let kit = run_node_fixture("commerce-sandbox", &input)?;
        assert_eq!(kit["memoryVersion"], 2);
        assert_eq!(kit["deliveryCount"], 1);
        std::fs::copy(
            directory.join("buyer/keys/recipient.key"),
            directory.join("recovery/recipient.key"),
        )?;
        std::fs::set_permissions(
            directory.join("recovery/recipient.key"),
            std::fs::Permissions::from_mode(0o600),
        )?;
        std::fs::remove_dir_all(directory.join("buyer"))?;
        std::fs::remove_file(directory.join("worker/recipient.key"))?;
        std::fs::remove_dir_all(directory.join("worker/job/sources"))?;
        input["phase"] = json!("recover-delivery");
        let recovered = run_node_fixture("commerce-sandbox", &input)?;
        assert_eq!(recovered["recovered"], true);
        assert_eq!(recovered["artifactDigest"], paid["artifactDigest"]);
        input["phase"] = json!("recover-kit");
        let kit_recovered = run_node_fixture("commerce-sandbox", &input)?;
        assert_eq!(kit_recovered["memoryCount"], 2);
        assert_eq!(kit_recovered["deliveryCount"], 1);
        assert_eq!(kit_recovered["payoutAttempt"], "1");
        assert_eq!(kit_recovered["artifactDigest"], paid["artifactDigest"]);
        Ok(())
    }
    .await;
    std::fs::remove_dir_all(directory)?;
    result
}

#[tokio::test]
async fn owner_wallet_controls_reconcile_external_signing_without_owner_keys() -> Result<()> {
    use near_workspaces::types::Gas;
    use std::os::unix::fs::DirBuilderExt;
    let (worker, contract, owner, _specialist, id) = fixture(NearToken::from_near(1)).await?;
    let runtime_key = SecretKey::from_seed(KeyType::ED25519, "owner-console-runtime-fixture");
    owner
        .batch(owner.id())
        .add_key(
            runtime_key.public_key(),
            AccessKey::function_call_access(
                contract.id(),
                &["checkpoint_memory", "create_job", "accept_job"],
                Some(NearToken::from_yoctonear(NEAR / 4)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let now = worker.view_block().await?.timestamp();
    owner.call(contract.id(), "set_delegate").args_json(json!({"agent_id":id,"delegate":{"publicKey":runtime_key.public_key().to_string(),"expiresAtNs":(now+24*HOUR).to_string(),"canCheckpoint":true,"canSpend":true}})).max_gas().transact().await?.into_result()?;
    wait_for_finalized_setup(&contract, &id).await?;
    let directory = std::env::temp_dir().join(format!(
        "persistara-owner-console-{}-{now}",
        std::process::id()
    ));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    // Public identities only: both owner and runtime secrets stay outside the application.
    let mut input = json!({"directory":directory,"rpcUrl":worker.rpc_addr(),"contractId":contract.id(),"signerId":owner.id(),"agentId":id,"runtimePublicKey":runtime_key.public_key().to_string()});
    let result: Result<()> = async {
        for paused in [true, false] {
            input["phase"] = json!("prepare");
            input["paused"] = json!(paused);
            let prepared = run_node_fixture("owner-sandbox", &input)?;
            let operation = &prepared["operation"];
            assert_eq!(prepared["ownerPrivateKeySupplied"], false);
            assert_eq!(prepared["runtimePrivateKeySupplied"], false);
            assert_eq!(
                operation["request"]["ownerPublicKey"],
                owner.secret_key().public_key().to_string()
            );
            input["operationId"] = operation["request"]["id"].clone();
            input["phase"] = json!("repeat");
            assert_eq!(
                run_node_fixture("owner-sandbox", &input)?["repeatedHandoffBlocked"],
                true
            );
            let args = operation["request"]["actions"][0]["params"]["args"].clone();
            let executed = owner
                .call(contract.id(), "set_paused")
                .args_json(args)
                .gas(Gas::from_tgas(100))
                .transact()
                .await?;
            let hash = executed.outcome().transaction_hash.to_string();
            executed.into_result()?;
            wait_for_finalized_setup(&contract, &id).await?;
            input["phase"] = json!("reconcile");
            input["transactionHash"] = json!(hash);
            let observed = run_node_fixture("owner-sandbox", &input)?;
            assert_eq!(observed["status"], "confirmed");
            assert_eq!(observed["paused"], paused);
            assert_eq!(
                run_node_fixture("owner-sandbox", &input)?["transactionHash"],
                hash
            );
        }
        let runtime = Account::from_secret_key(owner.id().clone(), runtime_key, &worker);
        let denied = runtime
            .call(contract.id(), "set_paused")
            .args_json(json!({"agent_id":id,"paused":true}))
            .gas(Gas::from_tgas(100))
            .transact()
            .await;
        match denied {
            Err(error) => assert!(format!("{error:?}").contains("MethodNameMismatch")),
            Ok(executed) => assert!(executed.into_result().is_err()),
        }
        assert_eq!(agent(&contract, &id).await?["paused"], false);
        Ok(())
    }
    .await;
    std::fs::remove_dir_all(directory)?;
    result
}

#[tokio::test]
async fn application_client_settles_and_recovers_memory_in_a_fresh_process() -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let (worker, contract, owner, specialist, id) = fixture(NearToken::from_near(1)).await?;
    let key = SecretKey::from_seed(KeyType::ED25519, "persistara-application-runtime-fixture");
    owner
        .batch(owner.id())
        .add_key(
            key.public_key(),
            AccessKey::function_call_access(
                contract.id(),
                &["checkpoint_memory", "create_job", "accept_job"],
                Some(NearToken::from_near(5)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let now = worker.view_block().await?.timestamp();
    owner.call(contract.id(), "set_delegate").args_json(json!({"agent_id":id,"delegate":{"publicKey":key.public_key().to_string(),"expiresAtNs":(now+24*HOUR).to_string(),"canCheckpoint":true,"canSpend":true}})).max_gas().transact().await?.into_result()?;
    wait_for_finalized_setup(&contract, &id).await?;
    let directory = std::env::temp_dir().join(format!(
        "persistara-application-{}-{now}",
        std::process::id()
    ));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let mut input = json!({"phase":"write","directory":directory,"rpcUrl":worker.rpc_addr(),"contractId":contract.id(),"signerId":owner.id(),"agentId":id,"publicKey":key.public_key().to_string(),"runtimeSecretKey":key.to_string(),"workerId":specialist.id(),"nowNs":now.to_string()});
    let result: Result<()> = async {
        let written = run_application_fixture(&input)?;
        assert_eq!(written["version"], 1);
        assert_eq!(written["memoryWriteStatus"], "pending");
        assert!(written["transactionHash"].is_string());
        input["checkpointOperationId"] = written["operationId"].clone();
        input.as_object_mut().unwrap().remove("runtimeSecretKey");
        input["phase"] = json!("resume-memory");
        let resumed = run_application_fixture(&input)?;
        assert_eq!(resumed["version"], 3);
        assert_eq!(resumed["memoryWriteStatus"], "committed");
        input["phase"] = json!("reserve");
        assert_eq!(run_application_fixture(&input)?["status"], "funded");
        specialist
            .call(contract.id(), "deliver")
            .args_json(json!({"agent_id":id,"operation_id":"job:client","result":blob("d")}))
            .max_gas()
            .transact()
            .await?
            .into_result()?;
        settle_gas_refunds(&worker).await?;
        let balance = specialist.view_account().await?.balance.as_yoctonear();
        input["phase"] = json!("accept");
        assert_eq!(run_application_fixture(&input)?["status"], "paid");
        assert_eq!(
            specialist.view_account().await?.balance.as_yoctonear(),
            balance + NEAR
        );
        assert_eq!(run_application_fixture(&input)?["status"], "paid");
        assert_eq!(
            specialist.view_account().await?.balance.as_yoctonear(),
            balance + NEAR
        );
        std::fs::remove_file(directory.join("runtime.key"))?;
        input["phase"] = json!("reconcile");
        assert_eq!(run_application_fixture(&input)?["status"], "confirmed");
        std::fs::remove_dir_all(directory.join("journal"))?;
        std::fs::remove_dir_all(directory.join("original-runtime"))?;
        input["phase"] = json!("recover");
        input.as_object_mut().unwrap().remove("runtimeSecretKey");
        let recovered = run_application_fixture(&input)?;
        assert_eq!(recovered["recovered"], 3);
        assert_eq!(recovered["currentFacts"], 2);
        assert_eq!(recovered["version"], 3);
        Ok(())
    }
    .await;
    std::fs::remove_dir_all(directory)?;
    result?;
    assert_eq!(agent(&contract, &id).await?["head"]["version"], "3");
    Ok(())
}

async fn wait_for_finalized_keys(owner: &Account) -> Result<()> {
    let expected = format!("{:?}", owner.view_access_keys().await?);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while format!(
        "{:?}",
        owner
            .view_access_keys()
            .finality(near_workspaces::types::Finality::Final)
            .await?
    ) != expected
    {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "account keys did not finalize"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Ok(())
}

#[tokio::test]
async fn owner_rotates_runtime_and_memory_then_recovers_without_either_runtime() -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let (worker, contract, owner, specialist, id) = fixture(NearToken::from_near(1)).await?;
    let old_key = SecretKey::from_seed(KeyType::ED25519, "persistara-rotation-old-runtime-fixture");
    owner
        .batch(owner.id())
        .add_key(
            old_key.public_key(),
            AccessKey::function_call_access(
                contract.id(),
                &["checkpoint_memory", "create_job", "accept_job"],
                Some(NearToken::from_near(5)),
            ),
        )
        .transact()
        .await?
        .into_result()?;
    let now = worker.view_block().await?.timestamp();
    owner.call(contract.id(), "set_delegate").args_json(json!({"agent_id":id,"delegate":{"publicKey":old_key.public_key().to_string(),"expiresAtNs":(now+24*HOUR).to_string(),"canCheckpoint":true,"canSpend":true}})).max_gas().transact().await?.into_result()?;
    wait_for_finalized_setup(&contract, &id).await?;
    let directory = std::env::temp_dir().join(format!(
        "persistara-owner-rotation-{}-{now}",
        std::process::id()
    ));
    std::fs::DirBuilder::new().mode(0o700).create(&directory)?;
    let mut input = json!({"phase":"write","directory":directory,"rpcUrl":worker.rpc_addr(),"contractId":contract.id(),"signerId":owner.id(),"agentId":id,"publicKey":old_key.public_key().to_string(),"runtimeSecretKey":old_key.to_string(),"workerId":specialist.id(),"nowNs":now.to_string()});
    let result: Result<()> = async {
        assert_eq!(run_application_fixture(&input)?["version"], 1);
        input.as_object_mut().unwrap().remove("runtimeSecretKey");
        input["phase"] = json!("resume-memory"); assert_eq!(run_application_fixture(&input)?["version"], 3);
        let before = agent(&contract, &id).await?;
        input["phase"] = json!("rotation-prepare");
        let prepared = run_application_fixture(&input)?;
        assert_eq!(prepared["nextEpoch"], 2);
        let next_public_key: near_workspaces::types::PublicKey = prepared["nextPublicKey"].as_str().unwrap().parse()?;
        for stage in ["begin", "remove-old-key", "install-new-key", "finish"] {
            input["phase"] = json!("rotation-next");
            let next = run_application_fixture(&input)?;
            assert_eq!(next["status"], "awaiting-owner-wallet"); assert_eq!(next["stage"], stage);
            let wallet = &next["request"];
            assert_eq!(wallet["signerId"], owner.id().as_str());
            assert_eq!(wallet["ownerPublicKey"], owner.secret_key().public_key().to_string());
            assert_eq!(wallet["actions"].as_array().unwrap().len(), 1);
            let params = &wallet["actions"][0]["params"];
            match stage {
                "begin" | "finish" => {
                    let method = if stage == "begin" { "begin_runtime_rotation" } else { "finish_runtime_rotation" };
                    assert_eq!(wallet["receiverId"], contract.id().as_str()); assert_eq!(params["methodName"], method); assert_eq!(params["deposit"], "0");
                    // Only the external owner harness signs. No owner secret is sent to the application.
                    owner.call(contract.id(), method).args_json(params["args"].clone()).max_gas().transact().await?.into_result()?;
                    let generation = agent(&contract, &id).await?["generation"].clone();
                    owner.call(contract.id(), method).args_json(params["args"].clone()).max_gas().transact().await?.into_result()?;
                    assert_eq!(agent(&contract, &id).await?["generation"], generation, "owner retry must be idempotent");
                    wait_for_finalized_setup(&contract, &id).await?;
                    if stage == "begin" {
                        let a = agent(&contract, &id).await?; assert_eq!(a["paused"], true); assert_eq!(a["keyEpoch"], "2");
                        assert!(!a["delegates"].as_array().unwrap().iter().any(|d| d["publicKey"] == old_key.public_key().to_string()));
                        let runtime = Account::from_secret_key(owner.id().clone(), old_key.clone(), &worker);
                        let rejected = runtime.call(contract.id(), "checkpoint_memory").args_json(json!({"agent_id":id,"generation":a["generation"],"expected_version":"3","next":{"version":"4","keyEpoch":"2","manifest":blob("e")}})).max_gas().transact().await?.into_result();
                        assert!(format!("{:?}", rejected.unwrap_err()).contains("ERR_AGENT_PAUSED"));
                    }
                }
                "remove-old-key" => {
                    assert_eq!(wallet["receiverId"], owner.id().as_str()); assert_eq!(params["publicKey"], old_key.public_key().to_string());
                    owner.batch(owner.id()).delete_key(old_key.public_key()).transact().await?.into_result()?;
                    wait_for_finalized_keys(&owner).await?;
                }
                "install-new-key" => {
                    assert_eq!(wallet["receiverId"], owner.id().as_str()); assert_eq!(params["publicKey"], prepared["nextPublicKey"]);
                    assert_eq!(params["accessKey"]["permission"]["receiverId"], contract.id().as_str());
                    assert_eq!(params["accessKey"]["permission"]["methodNames"], json!(["checkpoint_memory","create_job","accept_job"]));
                    assert_eq!(params["accessKey"]["permission"]["allowance"], NEAR.to_string());
                    owner.batch(owner.id()).add_key(next_public_key.clone(), AccessKey::function_call_access(contract.id(), &["checkpoint_memory","create_job","accept_job"], Some(NearToken::from_near(1)))).transact().await?.into_result()?;
                    wait_for_finalized_keys(&owner).await?;
                }
                _ => unreachable!(),
            }
        }
        // Even reinstalling the old access key cannot restore its revoked contract grant.
        owner.batch(owner.id()).add_key(old_key.public_key(), AccessKey::function_call_access(contract.id(), &["checkpoint_memory","create_job","accept_job"], Some(NearToken::from_near(5)))).transact().await?.into_result()?;
        let stale = Account::from_secret_key(owner.id().clone(), old_key.clone(), &worker);
        let a = agent(&contract, &id).await?;
        let checkpoint = stale.call(contract.id(), "checkpoint_memory").args_json(json!({"agent_id":id,"generation":a["generation"],"expected_version":"3","next":{"version":"4","keyEpoch":"2","manifest":blob("e")}})).max_gas().transact().await?.into_result();
        assert!(format!("{:?}", checkpoint.unwrap_err()).contains("ERR_UNAUTHORIZED_KEY"));
        let spend = stale.call(contract.id(), "create_job").args_json(json!({"request":request(&id,"revoked",&specialist,NEAR,&a["generation"],now)})).max_gas().transact().await?.into_result();
        assert!(format!("{:?}", spend.unwrap_err()).contains("ERR_UNAUTHORIZED_KEY"));
        assert!(job(&contract,&id,"revoked").await?.is_null());
        owner.batch(owner.id()).delete_key(old_key.public_key()).transact().await?.into_result()?; wait_for_finalized_keys(&owner).await?;
        input["phase"] = json!("rotation-write-verify");
        let verified = run_application_fixture(&input)?; assert_eq!(verified["status"], "verified"); assert_eq!(verified["version"], 4);
        assert_eq!(verified["historicalRecords"], 3); assert_eq!(verified["recoveredRecords"], 4);
        std::fs::remove_file(directory.join("runtime.key"))?;
        for name in ["original-runtime", "owner-rotation", "journal"] { std::fs::remove_dir_all(directory.join(name))?; }
        input["phase"] = json!("rotation-clean-recover");
        let recovered = run_application_fixture(&input)?;
        assert_eq!(recovered["recovered"], 4); assert_eq!(recovered["recoveredEpochs"], json!([1,2])); assert_eq!(recovered["originalRuntimeAvailable"], false);
        let after = agent(&contract, &id).await?; assert_eq!(after["keyEpoch"], "2"); assert_eq!(after["head"]["version"], "4");
        assert_eq!(after["available"], before["available"]); assert_eq!(after["deposited"], before["deposited"]); assert_conservation(&after);
        Ok(())
    }.await;
    std::fs::remove_dir_all(directory)?;
    result
}
