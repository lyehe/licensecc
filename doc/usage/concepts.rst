###########################################
Projects, features and versions
###########################################

Projects
================

Licensecc protects a native application by signing licenses with a publisher
private key and verifying those signatures with the corresponding public key.
The public key is compiled into the installed
``licensecc::licensecc_static`` runtime for the selected project.

Do not commit either generated key. The private key is publisher-only signing
authority and must never be distributed with the runtime; the build embeds only
the public material that consumers need to verify licenses.

A ``project`` is a signing trust domain: a directory containing the private
key, public-key headers, license output, and project customizations. Licensecc
configures one project into each build. Project material is generated outside
the source checkout, normally under the active build directory; the source tree
does not carry a pre-generated ``projects`` directory. A development build can
generate a ``DEFAULT`` project for its selected build tree.

::
    
	<generated project base>
	└── DEFAULT       #(your project name)
	    ├── include
	    │   └── licensecc
	    │       └── DEFAULT
	    │           ├── licensecc_properties.h
	    │           └── public_key.h
	    ├── licenses
	    │   └── test.lic
	    └── private_key.rsa

If you want to use or create a new project in the configure phase of CMake,
specify ``-DLCC_PROJECT_NAME`` and, when needed, an external
``-DLCC_PROJECTS_BASE_DIR``. See :doc:`../development/Build-the-library` for
the source-tree purity constraint.

A project can cover one executable or a group of executables that intentionally
share the same licensing authority. If ``Foo`` and ``Bar`` must accept
incompatible licenses, create two projects, such as ``FooLicensecc`` and
``BarLicensecc``:

* configure, build, and install Licensecc once with ``FooLicensecc``;
* repeat with ``BarLicensecc`` and a separate build/install prefix;
* retain each project's private key only in the publisher's signing system.

In each consumer, point ``CMAKE_PREFIX_PATH`` at the matching install prefix,
find the matching project component, and link the exported target. The
:doc:`../tutorials/offline-first-license` tutorial shows the complete
install-and-consume flow:

.. code-block:: cmake

  find_package(licensecc REQUIRED COMPONENTS "FooLicensecc")
  target_link_libraries(foo PRIVATE licensecc::licensecc_static)


Features
================

A licensed application can expose multiple functions that are enabled or
disabled independently. Each such function is a Licensecc ``feature``.
 
Issue all required features in one license instead of manually merging files.
Follow :doc:`issue-licenses` for the platform-specific generator path and add
the feature list to that guide's issue command:

.. code-block:: text

  --feature-names PROJECT_NAME,MY_AWESOME_FEATURE
	
The issue command writes the selected local ``.lic`` file and has no remote
side effects. To verify a feature, pass its name in ``CallerInformations`` (see
:ref:`verify license <api/public_api:Verify a license>`):

.. code-block:: c

  CallerInformations caller_info;
  LicenseInfo license_info;
  lcc_init_caller_informations(&caller_info);
  lcc_init_license_info(&license_info);

  const bool feature_set =
      lcc_set_caller_feature_name(&caller_info, "MY_AWESOME_FEATURE");
  const LCC_EVENT_TYPE result = feature_set
      ? acquire_license(&caller_info, nullptr, &license_info)
      : LICENSE_MALFORMED;  /* Fail closed when the ABI field is too small. */
	
For a complete fail-closed feature example, see
`examples/fail_closed_host <https://github.com/lyehe/licensecc/tree/main/examples/fail_closed_host>`_.

Versions
================

Caller-version input and license version limits are implemented in the C++
runtime. See the :doc:`capability registry <../capabilities/index>` for the
current evidence and limitations.
