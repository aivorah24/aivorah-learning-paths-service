const firebaseAdmin = require('../services/firebaseAdmin');
const supabase = require('../services/supabase');

async function resolveVerifiedUser(req, res, requiredRole) {
  const header = req.headers.authorization || '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return null;
  }
  if (!firebaseAdmin) {
    res.status(500).json({ error: 'Auth is not configured on this server' });
    return null;
  }
  let decoded;
  try {
    decoded = await firebaseAdmin.auth().verifyIdToken(match[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return null;
  }
  if (!decoded.email) {
    res.status(401).json({ error: 'Token has no email claim' });
    return null;
  }

  // users.id is the canonical identity every service resolves by email — not
  // the Firebase uid — so downstream tables (teacher_curricula, teacher_student)
  // key off it.
  const { data: user, error } = await supabase
    .from('users')
    .select('id, role')
    .eq('email', decoded.email)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return null;
  }
  if (!user || user.role !== requiredRole) {
    res.status(403).json({ error: `No ${requiredRole} account found for this identity` });
    return null;
  }

  return { uid: decoded.uid, email: decoded.email, userId: user.id };
}

async function requireAuth(req, res, next) {
  const resolved = await resolveVerifiedUser(req, res, 'teacher');
  if (!resolved) return;
  req.auth = { uid: resolved.uid, email: resolved.email, teacherId: resolved.userId };
  next();
}

async function requireStudentAuth(req, res, next) {
  const resolved = await resolveVerifiedUser(req, res, 'student');
  if (!resolved) return;
  req.auth = { uid: resolved.uid, email: resolved.email, studentId: resolved.userId };
  next();
}

module.exports = { requireAuth, requireStudentAuth };
