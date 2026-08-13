"""Sphinx configuration for the maintained Licensecc documentation site."""

from __future__ import annotations

import sys
from pathlib import Path


DOC_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(DOC_ROOT / "_ext"))

project = "Licensecc"
copyright = "2020, Open License Manager"
author = "Open License Manager"
version = "2.1.0"
release = "2.1.0"
language = "en"

extensions = [
    "sphinx.ext.autodoc",
    "sphinx.ext.autosectionlabel",
    "sphinx.ext.githubpages",
    "breathe",
    "myst_parser",
    "sphinx_sitemap",
    "licensecc_openapi",
]

source_suffix = {".rst": "restructuredtext", ".md": "markdown"}
master_doc = "index"
exclude_patterns = ["_build", "_doxygen"]
templates_path = ["_templates"]
primary_domain = "py"
pygments_style = "sphinx"

autosectionlabel_prefix_document = True
autodoc_class_signature = "separated"
autodoc_member_order = "bysource"
autodoc_typehints = "description"
autoclass_content = "both"

breathe_default_project = "licensecc"
breathe_domain_by_extension = {"h": "cpp", "hpp": "cpp"}
breathe_projects = {
    "licensecc": str(DOC_ROOT / "_doxygen" / "xml"),
}

html_theme = "sphinx_rtd_theme"
html_theme_options = {
    "collapse_navigation": False,
    "navigation_depth": 4,
    "titles_only": False,
}
html_static_path = ["_static"]
html_css_files = ["css/custom.css"]
html_js_files = ["https://buttons.github.io/buttons.js"]
html_favicon = "_static/lock_32.ico"
html_baseurl = "https://open-license-manager.github.io/licensecc/"
htmlhelp_basename = "licenseccdoc"
sitemap_url_scheme = "{link}"

latex_documents = [
    (master_doc, "licensecc.tex", "Licensecc Documentation", author, "manual"),
]
man_pages = [
    (master_doc, "licensecc", "Licensecc Documentation", [author], 1),
]
texinfo_documents = [
    (
        master_doc,
        "licensecc",
        "Licensecc Documentation",
        author,
        "licensecc",
        "Copy protection and licensing library documentation.",
        "Software Development",
    ),
]
