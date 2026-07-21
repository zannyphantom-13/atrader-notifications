const admin = require('firebase-admin');
const serviceAccount = require('c:/Users/Hassan/Downloads/atrader-54ae9-firebase-adminsdk-fbsvc-6e950c5919.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function dumpData() {
  console.log("=== AGENTS COLLECTION ===");
  const agentsSnap = await db.collection('agents').get();
  agentsSnap.forEach(doc => {
    console.log(`Document ID: ${doc.id}`);
    console.log(doc.data());
    console.log("------------------------");
  });
  
  process.exit(0);
}

dumpData();
