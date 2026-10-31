/* Drop Off — constants shared by every screen. Business data (places, service areas, vehicle classes,
   package sizes, pricing, accounts, deliveries) comes from the database through DO.api; the lists below are
   filled in when the first snapshot arrives. */
(function () {
  const D = (window.DO = window.DO || {});

  // Places, deliveries and GPS fixes use real WGS84 coordinates; maps are drawn with Leaflet (see ui.js).
  D.CLASS_ORDER = ['boda', 'car', 'minivan', 'pickup', 'truck'];
  D.PLACES = [];
  D.SIZES = [];

  D.TYPES = [
    { id: 'food', label: 'Food', size: 'small' }, { id: 'groceries', label: 'Groceries', size: 'small' },
    { id: 'pharmacy', label: 'Pharmacy', size: 'small' }, { id: 'documents', label: 'Documents', size: 'small' },
    { id: 'clothing', label: 'Clothing', size: 'small' }, { id: 'electronics', label: 'Electronics', size: 'small' },
    { id: 'cake', label: 'Cake', size: 'medium' }, { id: 'flowers', label: 'Flowers', size: 'small' },
    { id: 'furniture', label: 'Furniture', size: 'bulky' }, { id: 'appliance', label: 'Appliance', size: 'bulky' },
    { id: 'stock', label: 'Commercial stock', size: 'freight' }, { id: 'other', label: 'Other', size: 'small' }
  ];

  D.STATUS = {
    draft: { label: 'Awaiting payment', tone: 'mari', seg: 0 },
    pending: { label: 'Pending', tone: 'grey', seg: 0 },
    searching: { label: 'Finding driver', tone: 'info', seg: 0 },
    assigned: { label: 'Driver assigned', tone: 'pine', seg: 1 },
    en_route_pickup: { label: 'Heading to pickup', tone: 'pine', seg: 1 },
    at_pickup: { label: 'At pickup', tone: 'pine', seg: 1 },
    picked_up: { label: 'Picked up', tone: 'mari', seg: 2 },
    in_transit: { label: 'In transit', tone: 'mari', seg: 3 },
    approaching: { label: 'Arriving soon', tone: 'mari', seg: 3 },
    arrived: { label: 'Driver arrived', tone: 'mari', seg: 3 },
    awaiting_confirmation: { label: 'Awaiting PIN', tone: 'mari', seg: 3 },
    delivered: { label: 'Delivered', tone: 'ok', seg: 4 },
    failed: { label: 'Failed', tone: 'bad', seg: 0 },
    cancelled: { label: 'Cancelled', tone: 'grey', seg: 0 },
    disputed: { label: 'Disputed', tone: 'bad', seg: 4 }
  };
  D.ACTIVE = ['draft', 'searching', 'assigned', 'en_route_pickup', 'at_pickup', 'picked_up', 'in_transit', 'approaching', 'arrived', 'awaiting_confirmation'];
  D.MOVING = ['en_route_pickup', 'in_transit', 'approaching'];
  D.PRE_PICKUP = ['pending', 'searching', 'assigned', 'en_route_pickup', 'at_pickup'];

  D.DOC_KINDS = {
    national_id: 'National ID', driving_permit: 'Driving permit', vehicle_logbook: 'Vehicle logbook', insurance: 'Insurance certificate',
    profile_photo: 'Profile photo', selfie: 'Selfie holding your ID', business_registration: 'Business registration', tin_certificate: 'TIN certificate', trading_licence: 'Trading licence', other: 'Other document'
  };
  D.VERIFY = {
    pending: { label: 'Not submitted', tone: 'grey' }, submitted: { label: 'Submitted', tone: 'info' }, under_review: { label: 'Under review', tone: 'mari' },
    verified: { label: 'Verified', tone: 'ok' }, rejected: { label: 'Rejected', tone: 'bad' }, suspended: { label: 'Suspended', tone: 'bad' }
  };
  D.TICKET = { open: 'Open', in_review: 'In review', waiting_for_user: 'Waiting for user', resolved: 'Resolved', closed: 'Closed' };
})();
