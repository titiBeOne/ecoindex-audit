const fs = require("fs");
const path = require("path");
const folderTranslate = "translate";
const minify = require("html-minifier").minify;
const fse = require("fs-extra");
const defaultLang = "en-GB";
const {
  globalNoteTag,
  globalPerformanceTag,
  globalAccessibilityTag,
  globalBestPracticesTag,
  globalEcoIndexTag,
  performanceBlock,
  accessibilityBlock,
  bestPracticesBlock,
  ecoIndexBlock,
  htmlPerPageBlock,
} = require("./globalTag");

const {
  PageSizeTag,
  PageSizeRecommendationTag,
  PageComplexityTag,
  PageComplexityRecommendationTag,
  lighthouseReportPathTag,
  NumberOfRequestTag,
  NumberOfRequestRecommendationTag,
  greenItMetricsBlock,
  pageMetricsBlock,
  IconPerPageTag,
  numberPageTag,
  pageNameTag,
  statusClassPerPageTag,
} = require("./pageTag");
const ejs = require("ejs");
const { readTemplate } = require("./readTemplate");
const computeCssClassForMetrics = require("./utils/computeCssClassForMetrics");
const pageInErrorOrWarning = require("./utils/displayPageErrorIcon");
const { statusGreen } = require("./utils/statusGreen");
const { statusPerPage } = require("./utils/statusPerPage");
const { basename } = require("path");

const generateMetricMessage = (name, value, status, recommandation) => {
  if (name === "number_requests") {
    return `The number of HTTP requests (${value}) is below the configured threshold (${recommandation})`;
  } else if (name === "page_size") {
    return `The size of the page (${value}) is below the configured threshold (${recommandation})`;
  } else if (name === "Page_complexity") {
    return `The complexity of the page (${value}) is below the configured threshold (${recommandation})`;
  }
};


const generateReportsSonar = async (options, results) => {
  if (!options.sonarFilePath) {
    console.error("You should define the sonarFilePath property");
    process.exit(1);
  }

  const issues = [];

  const addIssues = (value, ruleId, name, engineId) => {
    if (options.fail > value) {
      issues.push({
        engineId: "eco-index",
        ruleId,
        severity: "MAJOR",
        type: "BUG",
        primaryLocation: {
          message: `You ${name} (${value}) is below the configured threshold (${options.fail})`,
          filePath: options.sonarFilePath,
        },
      });
    } else {
      if (options.fail <= value && value < options.pass) {
        issues.push({
          engineId,
          ruleId,
          severity: "MINOR",
          type: "BUG",
          primaryLocation: {
            message: `You ${name} (${value}) is below the configured threshold (${options.pass})`,
            filePath: options.sonarFilePath,
          },
        });
      }
    }
  };

  addIssues(results.ecoIndex, "eco-index-below-threshold", "ecoindex", "eco-index");

  results.perPages?.forEach(({ url, originalReport }) => {
    Object.entries(originalReport?.categories).forEach(([categoryName, categoryOption]) => {
      const auditRefs = categoryOption.auditRefs;
      auditRefs.forEach(({ id }) => {
        if(originalReport?.audits[id]){
          const auditResult = originalReport?.audits[id];
          if(auditResult.score === 0){
            issues.push({
              engineId: "lighthouse",
              ruleId: `${categoryName}-${id}`,
              severity: "MAJOR",
              type: "BUG",
              primaryLocation: {
                message: `${auditResult.title} - ${auditResult.description} (${url})`,
                filePath: options.sonarFilePath,
              },
            });
          }
        }
      });
    });
  });
  

  results.perPages?.forEach(({ url, metrics }) => {
    metrics?.forEach(({ name, value, status, recommandation }) => {
      if (status === "warning" || status === "error") {
        issues.push({
          engineId: "eco-index",
          ruleId: "eco-index-" + name.toLowerCase(),
          severity: status === "warning" ? "MINOR" : "MAJOR",
          type: "BUG",
          primaryLocation: {
            message:
                generateMetricMessage(name, value, status, recommandation) +
                ` (${url})`,
            filePath: options.sonarFilePath,
          },
        });
      }
    });
  });

  addIssues(results.performance, "performance-below-threshold", "performance", "lighthouse");
  addIssues(
    results.accessibility,
    "accessibility-below-threshold",
    "accessibility", "lighthouse"
  );
  addIssues(
    results.bestPractices,
    "bestPractices-below-threshold",
    "bestPractices", "lighthouse"
  );

  fs.writeFileSync(
    path.join(options.outputPath, "report.json"),
    JSON.stringify({ issues })
  );
};

const generateReports = async (options, results) => {
  if (!options?.pass) {
    options.pass = 90;
  }

  if (!options?.fail) {
    options.fail = 30;
  }

  if (options?.verbose) {
    console.log("Generate reports html.");
  }
  if (!options.lang) {
    options.lang = defaultLang;
  }

  options.translations = populateTranslation(options);

  if (options.srcLighthouse) {
    const finalSrcLighthouse =
      options.outputPath + "/" + basename(options.srcLighthouse);
    fse.copySync(options.srcLighthouse, finalSrcLighthouse, {
      overwrite: true,
    });
    options.srcLighthouse = finalSrcLighthouse;
  }
  if (options.srcEcoIndex) {
    const finalSrcEcoIndex =
      options.outputPath + "/" + basename(options.srcEcoIndex);
    fse.copySync(options.srcEcoIndex, finalSrcEcoIndex, { overwrite: true });
    options.srcEcoIndex = finalSrcEcoIndex;
  }

  const htmlPerPageResult = await populateTemplatePerPage(options, results);
  let htmlResult = await populateTemplate(options, results, htmlPerPageResult);

  const minifyOptions = {
    includeAutoGeneratedTags: true,
    removeAttributeQuotes: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    sortClassName: true,
    useShortDoctype: true,
    collapseWhitespace: true,
    minifyCSS: true,
  };

  if (options?.minify ?? true) {
    htmlResult = minify(htmlResult, minifyOptions);
  }

  fs.writeFileSync(path.join(options.outputPath, "report.html"), htmlResult);
};

const populateTemplate = async (options, results, htmlPerPageResult) => {
  const template = readTemplate("template.html");

  const performanceBlockTemplate = populateTemplatePerformance(
    options,
    results.performance,
    "global"
  );
  const accessibilityBlockTemplate = populateTemplateAccessibility(
    options,
    results.accessibility,
    "global"
  );
  const bestPracticesBlockTemplate = populateTemplateBestPractices(
    options,
    results.bestPractices,
    "global"
  );
  const ecoIndexBlockTemplate = populateTemplateEcoIndex(
    options,
    results.ecoIndex,
    "global"
  );

  const GlobalGreenItMetricsTemplate = populateGreentItMetrics(options, {
    greenhouseGases: results.greenhouseGases,
    greenhouseGasesKm: results.greenhouseGasesKm,
    water: results.water,
    waterShower: results.waterShower,
    waterNumberOfVisits: results.waterNumberOfVisits,
    gasesNumberOfVisits: results.gasesNumberOfVisits,
  });

  return ejs.render(template, {
    [globalNoteTag]: statusGreen(results.globalNote, options),
    [globalPerformanceTag]: performanceBlockTemplate,
    [globalAccessibilityTag]: accessibilityBlockTemplate,
    [globalEcoIndexTag]: ecoIndexBlockTemplate,
    [globalBestPracticesTag]: bestPracticesBlockTemplate,
    [htmlPerPageBlock]: htmlPerPageResult,
    GlobalGreenItMetrics: GlobalGreenItMetricsTemplate,
    Translations: options.translations,
    style: readTemplate("./style.css"),
    lang: options.lang,
  });
};

const populateMetrics = (options, metric) => {
  if (options?.verbose) {
    console.log("Populate metrics:", metric);
  }
  const template = readTemplate("templatePageMetrics.html");
  const NumberOfRequestMetric =
    metric?.find(m => m.name === "number_requests") ?? {};
  const PageSizeMetric = metric?.find(m => m.name === "page_size") ?? {};
  const PageComplexityMetric =
    metric?.find(m => m.name === "Page_complexity") ?? {};

  return ejs.render(template, {
    Translations: options.translations,
    [NumberOfRequestTag]: NumberOfRequestMetric.value,
    [NumberOfRequestRecommendationTag]: NumberOfRequestMetric.recommandation,
    NumberOfRequestCssClass: computeCssClassForMetrics(NumberOfRequestMetric),
    [PageSizeTag]: PageSizeMetric.value,
    [PageSizeRecommendationTag]: PageSizeMetric.recommandation,
    PageSizeCssClass: computeCssClassForMetrics(PageSizeMetric),
    [PageComplexityTag]: PageComplexityMetric.value,
    [PageComplexityRecommendationTag]: PageComplexityMetric.recommandation,
    PageComplexityCssClass: computeCssClassForMetrics(PageComplexityMetric),
  });
};

const populateGreentItMetrics = (
  options,
  {
    greenhouseGases,
    greenhouseGasesKm,
    water,
    waterShower,
    gasesNumberOfVisits,
    waterNumberOfVisits,
  }
) => {
  if (options?.verbose) {
    console.log("Populate GreenIt metrics:", {
      greenhouseGases,
      greenhouseGasesKm,
      water,
      waterShower,
      gasesNumberOfVisits,
      waterNumberOfVisits,
    });
  }

  const template = readTemplate("templateGreenItMetrics.html");
  const svgIconCo2 = readTemplate("co2.svg");
  const svgIconWater = readTemplate("water.svg");
  return ejs.render(template, {
    Translations: options.translations,
    greenhouseGases,
    greenhouseGasesKm,
    water,
    waterShower,
    gasesNumberOfVisits,
    waterNumberOfVisits,
    Translations: options.translations,
    mySvg: { svgIconCo2: svgIconCo2, svgIconWater: svgIconWater },
    gasesNumberOfVisits,
    waterNumberOfVisits,
    Translations: options.translations,
    mySvg: { svgIconCo2: svgIconCo2, svgIconWater: svgIconWater },
  });
};

const populateTemplatePerPage = async (options, results) => {
  let htmlPerPage = "";
  const defaultTemplatePerPage = readTemplate("templatePerPage.html");
  let numberPage = 0;
  results.perPages.forEach(page => {
    numberPage += 1;
    if (options?.verbose) {
      console.log("Populate reports page:", numberPage);
    }

    const performanceBlockTemplate = populateTemplatePerformance(
      options,
      page.performance,
      numberPage
    );
    const accessibilityBlockTemplate = populateTemplateAccessibility(
      options,
      page.accessibility,
      numberPage
    );
    const bestPracticesBlockTemplate = populateTemplateBestPractices(
      options,
      page.bestPractices,
      numberPage
    );
    const ecoIndexBlockTemplate = populateTemplateEcoIndex(
      options,
      page.ecoIndex,
      numberPage
    );
    const metricsTemplate = populateMetrics(options, page.metrics);
    const greenItMetricsTemplate = populateGreentItMetrics(options, {
      greenhouseGasesKm: page.greenhouseGasesKm,
      waterShower: page.waterShower,
      greenhouseGases: page.greenhouseGases,
      water: page.water,
      gasesNumberOfVisits:
        page.estimatation_water?.commentDetails?.numberOfVisit,
      waterNumberOfVisits: page.estimatation_co2?.commentDetails?.numberOfVisit,
    });

    const templatePerPage = ejs.render(defaultTemplatePerPage, {
      Translations: options.translations,
      [performanceBlock]: performanceBlockTemplate,
      [accessibilityBlock]: accessibilityBlockTemplate,
      [bestPracticesBlock]: bestPracticesBlockTemplate,
      [ecoIndexBlock]: ecoIndexBlockTemplate,
      [pageMetricsBlock]: metricsTemplate,
      [greenItMetricsBlock]: greenItMetricsTemplate,
      [numberPageTag]: numberPage,
      [pageNameTag]: page.pageName,
      [lighthouseReportPathTag]: page.lighthouseReport,
      [IconPerPageTag]: pageInErrorOrWarning(page, options),
      [statusClassPerPageTag]: statusPerPage(page, options),
    });
    htmlPerPage += templatePerPage;
  });
  return htmlPerPage;
};

const populateDoughnut = (value, label, options) => {
  const template = readTemplate("templateDoughnut.html");
  return ejs.render(template, {
    Class: generateCSSClassBasedOnValue(value, options),
    Value: value,
    Label: label,
  });
};

const populateTemplatePerformance = (options, performance, numberPage) => {
  if (options?.verbose) {
    console.log(
      `populate performance with value:${performance} for page ${numberPage}`
    );
  }
  return populateDoughnut(
    performance,
    options.translations.LabelPerformance,
    options
  );
};

const populateTemplateAccessibility = (options, accessibility, numberPage) => {
  if (options?.verbose) {
    console.log(
      `populate accessibility with value: ${accessibility} for page ${numberPage}`
    );
  }
  return populateDoughnut(
    accessibility,
    options.translations.LabelAccessibility,
    options
  );
};

const populateTemplateBestPractices = (options, bestPractices, numberPage) => {
  if (options?.verbose) {
    console.log(
      `populate bestPractices with value ${bestPractices} for page ${numberPage}`
    );
  }
  return populateDoughnut(
    bestPractices,
    options.translations.LabelBestPractices,
    options
  );
};

const populateTemplateEcoIndex = (options, ecoIndex, numberPage) => {
  if (options?.verbose) {
    console.log(
      `populate ecoIndex with value: ${ecoIndex} for page: ${numberPage}`
    );
  }
  return populateDoughnut(
    ecoIndex,
    options.translations.LabelEcoIndex,
    options
  );
};

const populateTranslation = options => {
  const i18nFile = `${options.lang}.json`;

  if (options?.verbose) {
    console.log("Translate by files:", i18nFile);
  }
  const templatePath = path.join(__dirname, folderTranslate, i18nFile);
  if (fs.existsSync(templatePath)) {
    return require(templatePath);
  }

  if (options?.verbose) {
    console.log(`The file ${i18nFile} does not exist. We will use the default one.`);
  }

  return populateTranslation({ ...options, lang: defaultLang});
};

const generateCSSClassBasedOnValue = (value, { pass, fail }) => {
  const cssPassClass = "lh-gauge__wrapper--pass";
  const cssAverageClass = "lh-gauge__wrapper--average";
  const cssFailClass = "lh-gauge__wrapper--fail";
  const cssNotApplicableClass = "lh-gauge__wrapper--not-applicable";

  if (value >= pass) return cssPassClass;
  else if (value < pass && value >= fail) return cssAverageClass;
  else if (value < fail) return cssFailClass;
  return cssNotApplicableClass;
};

module.exports = {
  generateReports,
  generateReportsSonar,
  populateTemplatePerformance,
  populateTemplateAccessibility,
  populateTemplateBestPractices,
  populateTemplateEcoIndex,
};
