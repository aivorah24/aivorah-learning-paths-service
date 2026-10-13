const { isCbse } = require('../curriculumName');

// Curricula whose own textbooks are in the system (NCERT books for CBSE). Their lessons are built from and shown
// beside those books. Every other curriculum (IB, Cambridge, ...) has no fixed book here: its lessons draw on any
// matching reference material, and no other curriculum's book, pages or names are ever shown to its students.
function usesNcertBooks(metadata) {
  return isCbse(metadata?.curriculum || 'CBSE');
}

module.exports = { usesNcertBooks };
