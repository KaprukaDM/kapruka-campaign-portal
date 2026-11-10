// functions/_lib/social-search-terms.js
// ============================================================================
//  Social search keyword bank — what people in Sri Lanka actually type into
//  TikTok / Instagram / Facebook search for cake, flowers and gifts.
//
//  Source: "Social Search Terms: Cake, Flowers, Gift, Online Shopping
//  (Sri Lanka)" report, collected from Sri Lanka on 2026-11-10.
//    - tiktok:    search suggestions in TikTok's ranked order (rank, not volume)
//    - instagram: hashtags with Instagram's own post counts (real volume)
//    - facebook:  search-box suggestions (light signal, account-personalised)
//
//  Used by functions/api/generate-social-seo.js. Refresh monthly when the
//  collector scripts are re-run.
// ============================================================================

export const SOCIAL_TERMS_COLLECTED = '2026-11-10';

export const SOCIAL_TERMS = {
  cake: {
    label: 'Cake',
    tiktok: [
      'cake surprise delivery in colombo',
      'online cake order in colombo',
      'colombo cake delivery',
      'colombo cake order',
      'cake delivery colombo',
      'birthday cake delivery sri lanka',
      'sri lanka cake delivery',
      'cake shops in colombo',
      'cake sri lanka online order',
      'birthday cake delivery in colombo',
      'cake delivery sri lanka',
      'birthday cake colombo',
      'lava cake online delivery in sri lanka',
      'bento cake online delivery in sri lanka',
      'birthday cake online order sri lanka',
      'cake online order in sri lanka',
      'colombo birthday cake delivery',
    ],
    instagram: [
      { tag: '#colombocakes', posts: 45300 },
      { tag: '#cakesrilanka', posts: 20700 },
      { tag: '#cakessrilanka', posts: 13100 },
      { tag: '#srilankacakes', posts: 12300 },
      { tag: '#cakescolombo', posts: 10500 },
      { tag: '#colombocake', posts: 5000 },
      { tag: '#srilankacake', posts: 5000 },
      { tag: '#cakecolombo', posts: 1000 },
    ],
    facebook: ['colombo cakes', 'cake delivery service', 'cake delivery online near me'],
  },

  flowers: {
    label: 'Flowers',
    tiktok: [
      'flower shops in colombo',
      'flowers delivery in sri lanka',
      'flower plant delivery in sri lanka',
      'flowers sri lanka',
      'flower shop colombo',
      'colombo flower bouquet',
      'flower vase delivery in sri lanka',
      'flowers colombo',
      'flower bouquet sri lanka',
      'colombo flower bouquet shop',
      'flower bouquet price sri lanka',
      'send flowers sri lanka',
      'fresh flower bouquet in sri lanka',
      'ribbon flower bouquet price in sri lanka',
      'flowers bouquet colombo',
    ],
    instagram: [
      { tag: '#srilankaflowers', posts: 5000 },
      { tag: '#colomboflowers', posts: 1000 },
      { tag: '#colomboflowershop', posts: 1000 },
      { tag: '#flowerssrilanka', posts: 1000 },
      { tag: '#flowerdeliverycolombo', posts: 500 },
      { tag: '#flowerdeliverysrilanka', posts: 500 },
      { tag: '#floristsrilanka', posts: 500 },
    ],
    facebook: ['send flowers to someone', 'send flowers to my job'],
  },

  gift: {
    label: 'Gift',
    tiktok: [
      'colombo birthday gift delivery',
      'gifts for your boyfriend in colombo',
      'birthday gift box delivery sri lanka',
      'gift delivery sri lanka',
      'gift ideas sri lanka',
      'customize gift ideas sri lanka',
      'colombo surprise delivery gifts',
      'gift box sri lanka for boys',
      'sri lankan gift delivery',
      'send gifts sri lanka',
      'gift sri lanka for girl',
      'gift delivery sri lanka for girls',
      'birthday gift online order sri lanka',
      'birthday gifts for girlfriend colombo',
      'customized gifts srilanka',
      'sri lanka gift delivery service',
    ],
    instagram: [
      { tag: '#srilankagifts', posts: 22400 },
      { tag: '#giftsrilanka', posts: 14300 },
      { tag: '#giftssrilanka', posts: 10200 },
      { tag: '#colombogifts', posts: 5000 },
      { tag: '#srilankagiftshop', posts: 1000 },
      { tag: '#giftscolombo', posts: 1000 },
      { tag: '#colombogiftshop', posts: 1000 },
      { tag: '#giftdeliverysrilanka', posts: 1000 },
      { tag: '#giftboxsrilanka', posts: 1000 },
    ],
    facebook: ['gift delivery surprise'],
  },
};

// Report's hashtag rule: 3–5 tags, one large (10K+ posts), the rest specific
// (500–5K). Flowers has no 10K+ tag, so its largest tag stands in.
export const LARGE_TAG_MIN = 10000;

export function isSupportedCategory(c) {
  return Object.prototype.hasOwnProperty.call(SOCIAL_TERMS, c);
}
