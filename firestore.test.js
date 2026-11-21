const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { test, before, after, beforeEach } = require("node:test");
const fs = require("node:fs");

let testEnv;
const PROJECT_ID = process.env.GCP_PROJECT || "demo-no-project";
const ALICE_UID = "alice_bee_123";
const BOB_UID = "bob_bee_456";

const [emulatorHost, emulatorPortStr] = (
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8085"
).split(":");
const emulatorPort = parseInt(emulatorPortStr, 10);

function validCreatePayload(uid, nowOffsetMs = -2000) {
  const ts = new Date(Date.now() + nowOffsetMs);
  return {
    userId: uid,
    slotName: "Slot 1: Royal Meadow",
    heroName: "Sir Buzzington",
    level: 1,
    xp: 0,
    xpToNext: 50,
    hp: 60,
    maxHp: 60,
    mp: 30,
    maxMp: 30,
    baseAtk: 10,
    baseDef: 5,
    skillPoints: 1,
    gold: 25,
    posX: 5,
    posY: 5,
    currentRegion: "SANCTUARY",
    equippedWeapon: "wooden_stinger",
    equippedShield: "",
    equippedCharm: "",
    unlockedSkills: [],
    inventoryItems: ["honey_vial:2", "wooden_stinger:1"],
    defeatedBosses: [],
    openedChests: [],
    discoveredRegions: ["SANCTUARY"],
    enemiesDefeated: 0,
    playTimeSeconds: 0,
    createdAt: ts,
    updatedAt: ts,
  };
}

before(async () => {
  const rules = fs.readFileSync("./firestore.rules", "utf8");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules,
      host: emulatorHost,
      port: emulatorPort,
    },
  });
});

after(async () => {
  if (testEnv) {
    await testEnv.cleanup();
  }
});

beforeEach(async () => {
  if (testEnv) {
    await testEnv.clearFirestore();
  }
});

test("Unauthenticated user cannot list, get, create, or delete save slots", async () => {
  const unauthDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(unauthDb.collection(`users/${ALICE_UID}/save_slots`).get());
  await assertFails(
    unauthDb.doc(`users/${ALICE_UID}/save_slots/slot_1`).set(validCreatePayload(ALICE_UID))
  );
  await assertFails(unauthDb.doc(`users/${ALICE_UID}/save_slots/slot_1`).delete());
});

test("Authenticated owner: empty list, create, partial update, and delete succeed", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const slotsCol = aliceDb.collection(`users/${ALICE_UID}/save_slots`);

  // Empty subcollection list must succeed
  await assertSucceeds(slotsCol.get());

  // Valid create (matches Kotlin SaveRepository create payload)
  const payload = validCreatePayload(ALICE_UID, -10000);
  await assertSucceeds(slotsCol.doc("slot_1").set(payload));

  // Valid partial update (mutable fields + updatedAt only; createdAt untouched)
  await assertSucceeds(
    slotsCol.doc("slot_1").update({
      level: 2,
      xp: 10,
      xpToNext: 100,
      hp: 75,
      maxHp: 75,
      skillPoints: 2,
      gold: 80,
      posX: 12,
      posY: 9,
      currentRegion: "MEADOW",
      unlockedSkills: ["keen_edge"],
      inventoryItems: ["honey_vial:3", "wooden_stinger:1"],
      discoveredRegions: ["SANCTUARY", "MEADOW"],
      enemiesDefeated: 4,
      playTimeSeconds: 120,
      updatedAt: new Date(Date.now() - 1000),
    })
  );

  await assertSucceeds(slotsCol.get());
  await assertSucceeds(slotsCol.doc("slot_1").delete());
});

test("Authenticated user cannot read, list, write, or delete another user's save slots", async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx
      .firestore()
      .doc(`users/${BOB_UID}/save_slots/slot_1`)
      .set(validCreatePayload(BOB_UID, -5000));
  });

  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  await assertFails(aliceDb.collection(`users/${BOB_UID}/save_slots`).get());
  await assertFails(aliceDb.doc(`users/${BOB_UID}/save_slots/slot_1`).get());
  await assertFails(
    aliceDb.doc(`users/${BOB_UID}/save_slots/slot_1`).update({ gold: 9999 })
  );
  await assertFails(
    aliceDb.doc(`users/${BOB_UID}/save_slots/slot_2`).set(validCreatePayload(BOB_UID))
  );
  await assertFails(aliceDb.doc(`users/${BOB_UID}/save_slots/slot_1`).delete());
});

test("Security bounds reject ghost fields, immutable mutations, invalid bounds, and future timestamps", async () => {
  const aliceDb = testEnv.authenticatedContext(ALICE_UID).firestore();
  const slotsCol = aliceDb.collection(`users/${ALICE_UID}/save_slots`);

  // Reject @DocumentId 'id' inside body
  const withId = { ...validCreatePayload(ALICE_UID), id: "slot_1" };
  await assertFails(slotsCol.doc("slot_1").set(withId));

  // Reject future timestamp
  const futurePayload = validCreatePayload(ALICE_UID, 60000);
  await assertFails(slotsCol.doc("slot_2").set(futurePayload));

  // Reject invalid level (> 99)
  const overLevel = { ...validCreatePayload(ALICE_UID), level: 200 };
  await assertFails(slotsCol.doc("slot_2").set(overLevel));

  // Create valid slot_3 then test immutable createdAt & userId guards on update
  await assertSucceeds(slotsCol.doc("slot_3").set(validCreatePayload(ALICE_UID, -10000)));
  await assertFails(
    slotsCol.doc("slot_3").update({
      createdAt: new Date(Date.now() - 1000),
      updatedAt: new Date(Date.now() - 500),
    })
  );
  await assertFails(
    slotsCol.doc("slot_3").update({
      userId: BOB_UID,
      updatedAt: new Date(Date.now() - 500),
    })
  );
});
