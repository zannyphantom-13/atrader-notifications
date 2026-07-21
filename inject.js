const admin = require('firebase-admin');
const serviceAccount = require('c:/Users/Hassan/Downloads/atrader-54ae9-firebase-adminsdk-fbsvc-6e950c5919.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function injectToken() {
  const agentRef = db.collection('agents').doc('14');
  await agentRef.set({
    pushToken: 'ExponentPushToken[Gh-5hJMD5QCA5irw-s1FxP]'
  }, { merge: true });
  
  console.log("SUCCESS! Injected pushToken into agents/14.");
  process.exit(0);
}

injectToken();
