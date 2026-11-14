// Text of the mandate settings view, in each view language. Order-limit and pay-on-order
// labels come from ORDER_WORDING in @app/ui/format.

const en = {
  agentSettings: "Agent settings",
  title: "Agent limits",
  loading: "Loading agent limits…",
  noMandateTitle: "No current mandate",
  noMandateBody:
    "The agent has no current authority to place orders. Ask the agent to draft limits, then check them and press Register.",
  loadFailedTitle: "Agent limits could not be loaded",
  loadFailedBody: "Try again or open the limits page.",
  tryAgain: "Try again",
  openLimitsPage: "Open limits page",
  status: { active: "Active", revoked: "Revoked", expired: "Expired" },
  version: (version: number) => `Version ${version}`,
  activeNote: "Automatic placement is subject to these limits and other fixed checks.",
  inactiveNote:
    "No current authority: these historical limits are not in force and cannot authorize orders.",
  previousLimits: "Previous limits and policies",
  orderLimits: "Order limits",
  perOrder: (amount: string) =>
    `${amount} per order, including VAT and deposits. At or below this limit, automatic placement is allowed subject to other checks; above it, approval is required.`,
  categories: "Categories",
  allCategories: "All categories",
  noCategories: "No categories",
  categoriesAll: "All categories are eligible for automatic placement, subject to other checks.",
  categoriesNone: "No categories are eligible for automatic placement; approval is required.",
  categoriesListed:
    "Listed categories are eligible for automatic placement, subject to other checks; other categories require approval.",
  substitutions: "Substitutions",
  newProducts: "Products not previously ordered by this customer",
  productData: "Product data",
  minReliability: "Minimum delivery reliability",
  reliabilityRule:
    "At or above the minimum, automatic placement is allowed subject to other checks; below it, approval is required.",
  maxCo2: "Maximum estimated CO₂-equivalent per kg",
  co2PerKg: (amount: string) => `${amount} CO₂-eq per kg`,
  co2Rule:
    "At or below the maximum, automatic placement is allowed subject to other checks; above it, approval is required.",
  missingAllergen: "Missing allergen data",
  allergenRule: (policy: string) =>
    `${policy} when an allergen constraint is unknown. Contradicted or missing matches still require approval.`,
  paymentTerms: "Payment terms",
  invoice: "Invoice",
  standingConstraints: "Standing constraints",
  required: "Required",
  preferred: "Preferred",
  none: "None",
  freeFromLactose: "Free from lactose",
  validity: "Validity",
  issued: "Issued",
  expires: "Expires",
  readOnly:
    "This view is read-only. An approver must authorize changes. Unusual quantities and unconfirmed stock can still require approval; other checks also apply.",
  technicalDetails: "Technical details",
  mandateId: "Mandate ID",
  customer: "Customer",
  agent: "Agent",
  signedBy: "Signed by",
  registered: "Registered",
  autoPolicy: "Automatic placement allowed, subject to other checks",
  askPolicy: "Ask for approval",
  noSubstitutes: "Substitute offers are not allowed",
  noThreshold: "No threshold set",
  threshold: (value: string, policy: string) => `${value}. If data is missing: ${policy}.`,
  oneYear: "One year after registration",
  draftStatus: "Draft · not registered",
  draftNote:
    "The agent drafted these limits from your request. Check them and press Register to put them in force. Nothing changes before you register.",
  draftCompare: (version: number) =>
    `Compared with version ${version}, which is in force now. A changed term shows the value in force under it.`,
  draftNoCurrent:
    "No mandate is in force now. The agent cannot place orders until you register limits.",
  draftUnknownCurrent:
    "The view cannot tell which limits are in force now. Ask the agent to read the mandate.",
  proposedLimits: "Proposed limits",
  inForce: (value: string) => `In force now: ${value}`,
  register: "Register limits",
  registering: "Registering…",
  registerFailedTitle: "The limits were not registered",
  registerFailedBody:
    "Press Register again. A repeated Register does not register the limits twice.",
  humanOnly: "Only you can register limits. The agent cannot register them.",
  registerUnconfirmedTitle: "Registration is not confirmed",
  registerUnconfirmedBody:
    "The answer did not arrive, so the view cannot tell whether the limits are in force. Press Register again: a repeated Register does not register the limits twice.",
};

const fi: typeof en = {
  agentSettings: "Agentin asetukset",
  title: "Agentin rajat",
  loading: "Ladataan agentin rajoja…",
  noMandateTitle: "Ei voimassa olevaa valtuutusta",
  noMandateBody:
    "Agentilla ei ole valtuutusta tehdä tilauksia. Pyydä agenttia laatimaan rajat, tarkista ne ja paina Rekisteröi.",
  loadFailedTitle: "Agentin rajoja ei voitu ladata",
  loadFailedBody: "Yritä uudelleen tai avaa rajasivu.",
  tryAgain: "Yritä uudelleen",
  openLimitsPage: "Avaa rajasivu",
  status: { active: "Voimassa", revoked: "Peruttu", expired: "Vanhentunut" },
  version: (version) => `Versio ${version}`,
  activeNote: "Automaattinen tilaus noudattaa näitä rajoja ja muita kiinteitä tarkistuksia.",
  inactiveNote:
    "Ei voimassa olevaa valtuutusta: nämä aiemmat rajat eivät ole voimassa eivätkä oikeuta tilauksiin.",
  previousLimits: "Aiemmat rajat ja käytännöt",
  orderLimits: "Tilausrajat",
  perOrder: (amount) =>
    `${amount} tilausta kohden, sisältää ALV:n ja panttimaksut. Rajan alittuessa tai täyttyessä tilaus voidaan tehdä automaattisesti muiden tarkistusten puitteissa; rajan ylittyessä tarvitaan hyväksyntä.`,
  categories: "Tuoteryhmät",
  allCategories: "Kaikki tuoteryhmät",
  noCategories: "Ei tuoteryhmiä",
  categoriesAll:
    "Kaikki tuoteryhmät voidaan tilata automaattisesti muiden tarkistusten puitteissa.",
  categoriesNone: "Mitään tuoteryhmää ei voi tilata automaattisesti; tarvitaan hyväksyntä.",
  categoriesListed:
    "Luetellut tuoteryhmät voidaan tilata automaattisesti muiden tarkistusten puitteissa; muut tuoteryhmät vaativat hyväksynnän.",
  substitutions: "Korvaavat tuotteet",
  newProducts: "Tuotteet, joita asiakas ei ole aiemmin tilannut",
  productData: "Tuotetiedot",
  minReliability: "Toimitusvarmuuden vähimmäistaso",
  reliabilityRule:
    "Vähimmäistasolla tai sen yli tilaus voidaan tehdä automaattisesti muiden tarkistusten puitteissa; sen alla tarvitaan hyväksyntä.",
  maxCo2: "Arvioidun CO₂-ekvivalentin enimmäismäärä kilolta",
  co2PerKg: (amount) => `${amount} CO₂-ekv. kilolta`,
  co2Rule:
    "Enimmäismäärässä tai sen alle tilaus voidaan tehdä automaattisesti muiden tarkistusten puitteissa; sen yli tarvitaan hyväksyntä.",
  missingAllergen: "Puuttuva allergeenitieto",
  allergenRule: (policy) =>
    `${policy}, kun allergeenivaatimuksen tieto puuttuu. Ristiriitaiset tai puuttuvat osumat vaativat silti hyväksynnän.`,
  paymentTerms: "Maksuehdot",
  invoice: "Lasku",
  standingConstraints: "Pysyvät vaatimukset",
  required: "Pakollinen",
  preferred: "Toivottu",
  none: "Ei mitään",
  freeFromLactose: "Laktoositon",
  validity: "Voimassaolo",
  issued: "Myönnetty",
  expires: "Päättyy",
  readOnly:
    "Tätä näkymää voi vain lukea. Muutokset vaativat hyväksyjän luvan. Poikkeavat määrät ja vahvistamaton saldo voivat silti vaatia hyväksynnän; myös muut tarkistukset ovat voimassa.",
  technicalDetails: "Tekniset tiedot",
  mandateId: "Valtuutuksen tunnus",
  customer: "Asiakas",
  agent: "Agentti",
  signedBy: "Allekirjoittaja",
  registered: "Rekisteröity",
  autoPolicy: "Automaattinen tilaus sallittu muiden tarkistusten puitteissa",
  askPolicy: "Pyydä hyväksyntä",
  noSubstitutes: "Korvaavia tarjouksia ei sallita",
  noThreshold: "Rajaa ei ole asetettu",
  threshold: (value, policy) => `${value}. Jos tieto puuttuu: ${policy}.`,
  oneYear: "Vuoden kuluttua rekisteröinnistä",
  draftStatus: "Luonnos · ei rekisteröity",
  draftNote:
    "Agentti laati nämä rajat pyyntösi perusteella. Tarkista ne ja paina Rekisteröi, niin ne tulevat voimaan. Mikään ei muutu ennen rekisteröintiä.",
  draftCompare: (version) =>
    `Verrattu versioon ${version}, joka on nyt voimassa. Muuttuneen kohdan alla näkyy voimassa oleva arvo.`,
  draftNoCurrent:
    "Mikään valtuutus ei ole nyt voimassa. Agentti ei voi tehdä tilauksia ennen kuin rekisteröit rajat.",
  draftUnknownCurrent:
    "Näkymä ei tiedä, mitkä rajat ovat nyt voimassa. Pyydä agenttia lukemaan valtuutus.",
  proposedLimits: "Ehdotetut rajat",
  inForce: (value) => `Nyt voimassa: ${value}`,
  register: "Rekisteröi rajat",
  registering: "Rekisteröidään…",
  registerFailedTitle: "Rajoja ei rekisteröity",
  registerFailedBody:
    "Paina Rekisteröi uudelleen. Toistettu rekisteröinti ei rekisteröi rajoja kahdesti.",
  humanOnly: "Vain sinä voit rekisteröidä rajat. Agentti ei voi rekisteröidä niitä.",
  registerUnconfirmedTitle: "Rekisteröintiä ei ole vahvistettu",
  registerUnconfirmedBody:
    "Vastaus ei tullut perille, joten näkymä ei tiedä, ovatko rajat voimassa. Paina Rekisteröi uudelleen: toistettu rekisteröinti ei rekisteröi rajoja kahdesti.",
};

export const MANDATE = { en, fi };
