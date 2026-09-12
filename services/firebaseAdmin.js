let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    let credential = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
      const svcJson = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
      credential = admin.credential.cert(svcJson);
      console.log('[firebase-admin] initialised from FIREBASE_SERVICE_ACCOUNT_B64 env var');
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const svcJson = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      credential = admin.credential.cert(svcJson);
      console.log('[firebase-admin] initialised from FIREBASE_SERVICE_ACCOUNT env var');
    } else {
      const svcPath = require('path').join(__dirname, '../firebase-service-account.json');
      if (require('fs').existsSync(svcPath)) {
        credential = admin.credential.cert(require(svcPath));
        console.log('[firebase-admin] initialised from service account file');
      }
    }

    if (credential) {
      admin.initializeApp({ credential });
      firebaseAdmin = admin;
    } else {
      console.warn('[firebase-admin] no service account found — teacher-curriculum auth will reject all requests');
    }
  } else {
    firebaseAdmin = admin;
  }
} catch (e) {
  console.warn('[firebase-admin] not available:', e.message);
}

module.exports = firebaseAdmin;
