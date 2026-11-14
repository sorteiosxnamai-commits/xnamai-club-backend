export const clubOffers = {
  LAUNCH: { original: 29999, card: 14997, pix: 19999, boleto: 19999,
    cardUrl: 'https://www.asaas.com/000/c/dyt747auecm0y89b',
    pixUrl: 'https://www.asaas.com/000/c/o1ec2qy62xy2osok',
    boletoUrl: 'https://www.asaas.com/000/c/o1ec2qy62xy2osok' },
  PRIORITY: { original: 59999, card: 29797, pix: 34999, boleto: 34999,
    cardUrl: 'https://www.asaas.com/000/c/h0k06a6rr4d00swi',
    pixUrl: 'https://www.asaas.com/000/c/dh2huehi75bvitg5',
    boletoUrl: 'https://www.asaas.com/000/c/dh2huehi75bvitg5' },
};
export function clubOffer(code: string) {
  if (code !== 'LAUNCH' && code !== 'PRIORITY') throw new Error('Plano sem oferta de lançamento configurada.');
  return clubOffers[code];
}
