export const validate =
  (schema, target = 'body') =>
  (req, res, next) => {
    try {
      req[target === 'query' ? 'validatedQuery' : 'validatedBody'] = schema.parse(req[target]);
      next();
    } catch (error) {
      next(error);
    }
  };
