// Receita Federal / Serpro: twelve alphanumeric positions followed by two numeric DVs.
export function normalizeCnpj(value: string) {
  return value.trim().toUpperCase().replace(/[.\-/\s]/g, '');
}

export function isValidCnpj(value: string) {
  const document = normalizeCnpj(value);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(document) || /^(.)\1+$/.test(document)) return false;
  const check = (weights: number[]) => {
    const sum = weights.reduce((total, weight, index) => total + (document.charCodeAt(index) - 48) * weight, 0);
    const rest = sum % 11;
    return (rest < 2 ? 0 : 11 - rest) === Number(document[weights.length]);
  };
  return check([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) && check([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
}

export function formatCnpj(value: string) {
  return normalizeCnpj(value).replace(/[^A-Z0-9]/g, '').slice(0, 14)
    .replace(/^(.{2})(.)/, '$1.$2').replace(/^(.{6})(.)/, '$1.$2')
    .replace(/^(.{10})(.)/, '$1/$2').replace(/^(.{15})(.)/, '$1-$2');
}
