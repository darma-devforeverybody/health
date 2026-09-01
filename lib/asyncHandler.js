// Express 4 doesn't catch rejected promises from async route handlers —
// without this, a thrown DB error crashes the whole process instead of
// producing a 400 response (unlike the old Supabase {data,error} pattern).
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
