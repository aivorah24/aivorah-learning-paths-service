const supabase = require('../services/supabase');

function requireOwnedCurriculum(idParam = 'id') {
  return async (req, res, next) => {
    const id = req.params[idParam];
    const { data, error } = await supabase
      .from('teacher_curricula')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Curriculum not found' });
    if (data.teacher_id !== req.auth.teacherId) {
      return res.status(403).json({ error: 'Not authorized for this curriculum' });
    }
    req.curriculum = data;
    next();
  };
}

module.exports = { requireOwnedCurriculum };
